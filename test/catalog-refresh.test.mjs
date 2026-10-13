import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "dotenv";
import pg from "pg";
import { sentenceCaseProductName } from "../dist/catalog/product-name.js";
import { planCatalogRefresh } from "../dist/catalog/catalog-refresh-plan.js";
import { refreshCatalog } from "../scripts/refresh-catalog.mjs";
import { LedgerService } from "../dist/ledger/ledger.service.js";
import { DatabaseService } from "../dist/database/database.service.js";
import { InventoryEntity } from "../dist/database/operations.entities.js";
import { ProductEntity } from "../dist/database/entities.js";

const product = (name, code = "FC36S-600-304") => ({ name, code, alternateCode: "", brand: "Fulco" });
test("Names use natural sentence case, retain accents/technical codes and are idempotent", () => {
  for (const [input, expected] of [
    ["GIÁ BÁT ĐĨA TỦ TRÊN INOX OVAL 304", "Giá bát đĩa tủ trên inox oval 304"],
    ["BẾP TỪ 2 VÙNG NẤU MẶT KÍNH KANGER CAO CẤP", "Bếp từ 2 vùng nấu mặt kính Kanger cao cấp"],
    ["Vòi Rửa Inox SUS304 Cao Cấp", "Vòi rửa inox SUS304 cao cấp"],
    ["NỒI CƠM ĐIỆN FULCO CAO CẤP", "Nồi cơm điện Fulco cao cấp"],
    ["HÚT MÙI CHỮ T FULCO CAO CẤP", "Hút mùi chữ T Fulco cao cấp"],
    ["NỒI LUỘC GÀ INOX 304-DUNG TÍCH 10.4L", "Nồi luộc gà inox 304-dung tích 10.4L"],
    ["LED 12V 8W", "LED 12V 8W"],
    ["Chậu rửa 1 hố kiểu Nhật", "Chậu rửa 1 hố kiểu Nhật"],
    ["FULCO FC36S-600-304", "Fulco FC36S-600-304"],
    ["", ""],
  ]) {
    const result = sentenceCaseProductName(product(input));
    assert.equal(result, expected);
    assert.equal(sentenceCaseProductName(product(result)), result);
  }
  assert.equal(sentenceCaseProductName(product("Fulco FC-JP668i-Plus", "FC-JP668i-Plus")), "Fulco FC-JP668i-Plus");
  assert.equal(sentenceCaseProductName(product("Fulco FCP303-Đ", "FCP303-Đ")), "Fulco FCP303-Đ");
});
test("Stock planning honors branch balances, reservation limits, private flags and existing values", () => {
  const row = { id:"QA",revision:2,published:false,data:{...product("VÒI RỬA"),id:"QA",stock:0} };
  const snapshot=JSON.stringify(row);
  const plan=planCatalogRefresh([row],[],[]);
  assert.equal(plan.names[0].name,"Vòi rửa");
  assert.equal(plan.adjustments.length,3);
  assert.ok(plan.adjustments.every(item=>item.delta===100));
  assert.equal(plan.summary.private,1);
  assert.equal(JSON.stringify(row),snapshot);
  const reserved={branch:"Quy Nhơn",data:{id:"ORDER",status:"Chờ soạn hàng",items:[{productId:"QA",quantity:101}]}};
  assert.throws(()=>planCatalogRefresh([row],[],[reserved]),/below reserved/);
  assert.equal(planCatalogRefresh([row],[],[{...reserved,data:{...reserved.data,status:"Đã hủy"}}]).adjustments.length,3);
});

config({path:".env.local",quiet:true});
if(!process.env.DATABASE_URL||new URL(process.env.DATABASE_URL).hostname!=="127.0.0.1")throw new Error("Catalog refresh QA only targets local PostgreSQL.");
test("Apply backs up first, journals stock, preserves unrelated data and does not reset stock after handoff", async()=>{
  const schema=`refresh_qa_${randomBytes(6).toString("hex")}`;
  const directory=await mkdtemp(join(tmpdir(),"baotin-catalog-refresh-"));
  const backupPath=join(directory,"snapshot.json");
  const client=new pg.Client({connectionString:process.env.DATABASE_URL});await client.connect();
  const db=new DatabaseService();
  const previousEnv={DB_SCHEMA:process.env.DB_SCHEMA,DB_SYNCHRONIZE:process.env.DB_SYNCHRONIZE,DB_SSL:process.env.DB_SSL};
  process.env.DB_SCHEMA=schema;process.env.DB_SYNCHRONIZE="true";process.env.DB_SSL="false";
  try{
    await db.onModuleInit();
    const data={...product("GIÁ BÁT INOX 304"),id:"QA",slug:"qa-product",category:"qa-category",image:"/images/catalog/kitchen.png",gallery:["/images/catalog/kitchen.png"],price:100000,listPrice:250000,b2cDiscount:60,b2bDiscount:65,stock:0,featured:true,variantAttributes:[{name:"Kích thước",value:"600mm"}]};
    const privateData={...data,id:"PRIVATE",slug:"private",code:"FC-P",name:"Fulco FC-P"};
    await db.source.getRepository(ProductEntity).save([{id:data.id,slug:data.slug,data,published:true},{id:privateData.id,slug:privateData.slug,data:privateData,published:false}]);
    const before=(await client.query(`SELECT * FROM "${schema}".products ORDER BY id`)).rows;
    assert.equal((await refreshCatalog(client,schema)).applied,false);
    await assert.rejects(refreshCatalog(client,schema,{apply:true}),/backup path/);
    await writeFile(backupPath,"existing backup");
    await assert.rejects(refreshCatalog(client,schema,{apply:true,backupPath}),/EEXIST/);
    assert.deepEqual((await client.query(`SELECT * FROM "${schema}".products ORDER BY id`)).rows,before);
    await rm(backupPath);
    const result=await refreshCatalog(client,schema,{apply:true,backupPath});
    assert.equal(result.summary.inventoryBalancesUpdated,6);
    assert.equal((await stat(backupPath)).mode&0o777,0o600);
    const backup=JSON.parse(await readFile(backupPath,"utf8"));
    assert.deepEqual(backup.products,JSON.parse(JSON.stringify(before)));
    const after=(await client.query(`SELECT * FROM "${schema}".products ORDER BY id`)).rows;
    for(let index=0;index<after.length;index++)assert.deepEqual(after[index],{...before[index],revision:before[index].revision+1,data:{...before[index].data,stock:100,name:sentenceCaseProductName(before[index].data)}});
    assert.equal((await client.query(`SELECT COUNT(*) FROM "${schema}".ledger_entries WHERE kind='stock'`)).rows[0].count,"6");
    const ledger=new LedgerService(db);
    assert.equal((await ledger.stock([data],"Quy Nhơn"))[0].stock,100);
    assert.equal((await ledger.stock([data],"Tuy Hòa"))[0].stock,100);
    await db.transaction(manager=>ledger.handoff(manager,{id:"QA-HANDOFF",branch:"Quy Nhơn",items:[{productId:"QA",quantity:3}],credit:false},"QA"));
    assert.equal((await ledger.stock([data],"Quy Nhơn"))[0].stock,97);
    assert.equal((await ledger.stock([data],"Nha Trang"))[0].stock,100);
    const repeated=await refreshCatalog(client,schema,{apply:true,backupPath});
    assert.equal(repeated.alreadyApplied,true);
    assert.equal((await ledger.stock([data],"Quy Nhơn"))[0].stock,97);
    assert.equal((await db.source.getRepository(InventoryEntity).find()).length,6);
    assert.equal((await client.query(`SELECT COUNT(*) FROM "${schema}".audit_events`)).rows[0].count,"1");
  }finally{
    await db.onModuleDestroy();
    for(const [key,value]of Object.entries(previousEnv)){if(value===undefined)delete process.env[key];else process.env[key]=value;}
    await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);await client.end();await rm(directory,{recursive:true,force:true});
  }
});
