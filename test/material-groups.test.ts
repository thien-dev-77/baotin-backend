import test from "node:test";
import assert from "node:assert/strict";
import { availableMaterialGroups, materialGroups, matchesMaterialGroups } from "../src/catalog/material-groups";

const cases: [string, string[]][] = [
  ["SUS304", ["inox-304"]],
  ["SUS 304", ["inox-304"]],
  ["INOX 304 xước mờ", ["inox-304"]],
  ["Inox SUS304 và nhựa ABS", ["inox-304", "plastic"]],
  ["khung Inox 304 xước mờ. Vách + hộp lực bằng thép sơn tĩnh", ["inox-304", "steel"]],
  ["Khung sườn bằng nhôm, ray bằng thép không gỉ", ["inox-other", "aluminum"]],
  ["Thép không gỉ", ["inox-other"]],
  ["Thép / Nhựa", ["steel", "plastic"]],
  ["Nhôm và nhựa", ["aluminum", "plastic"]],
  ["Hợp kim kẽm + nắp nhựa", ["plastic", "alloy"]],
  ["- Thân Zamak; - Đầu chia nước Neoperl", ["alloy"]],
  ["Đồng mạ crôm và đá granite", ["copper", "stone"]],
  ["Cửa kính toàn phần, 3 lớp cách nhiệt", ["glass"]],
  ["Mặt gốm thủy tinh SCHOTT Ceran", ["glass"]],
  ["Polyamid", ["plastic"]],
  ["Cao su tổng hợp", ["rubber"]],
  ["Thanh chắn: Nhôm; ron: Silicone, tự dập lửa", ["aluminum", "rubber"]],
  ["Gỗ MDF", ["wood"]],
  ["Sứ", ["ceramic"]],
  ["Màu kem", ["other"]],
  ["Inox, kích thước 304mm", ["inox-other"]],
  ["Inox 201", ["inox-other"]],
  ["Vật liệu chưa xác định", ["other"]],
  ["", []],
  ["  ", []],
];

for (const [value, expected] of cases) {
  test("Material tags: " + JSON.stringify(value), () => {
    assert.deepEqual(materialGroups(value), expected);
  });
}

test("Compound materials use OR within material groups, preserving the source", () => {
  const raw = "Inox SUS304 và nhựa ABS";
  assert.equal(matchesMaterialGroups(raw, ["plastic"]), true);
  assert.equal(matchesMaterialGroups(raw, ["inox-304", "steel"]), true);
  assert.equal(matchesMaterialGroups(raw, ["steel"]), false);
  assert.equal(matchesMaterialGroups(raw, []), true);
  assert.equal(raw, "Inox SUS304 và nhựa ABS");
});

test("Options deduplicate spelling variations and retain selected groups", () => {
  assert.deepEqual(availableMaterialGroups(["SUS304", "SUS 304", "Inox 304 xước mờ", "Polyamid"], ["copper"]).map(group => group.value),
    ["inox-304", "plastic", "copper"]);
  assert.deepEqual(availableMaterialGroups(["", " "]), []);
});
