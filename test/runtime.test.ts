import test from "node:test";
import assert from "node:assert/strict";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import ts from "typescript";
import { runtimeAssetPath, startupErrorDetails } from "../src/runtime-assets";

test("Runtime paths keep repository assets and explicit absolute paths", () => {
  assert.equal(
    runtimeAssetPath("./certs/prod-ca-2021.crt"),
    resolve("certs/prod-ca-2021.crt"),
  );
  assert.equal(runtimeAssetPath("seed/mock.json"), resolve("seed/mock.json"));
  assert.equal(runtimeAssetPath("media"), resolve("media"));
  assert.equal(runtimeAssetPath("/mounted/media"), "/mounted/media");
});

test("Startup diagnostics identify missing files without logging connection secrets", () => {
  const missing = Object.assign(new Error("Untrusted error message"), {
    code: "ENOENT",
    path: "/app/certs/missing.crt",
  });
  assert.equal(startupErrorDetails(missing).path, "/app/certs/missing.crt");
  assert.match(startupErrorDetails(missing).hint, /DB_SSL_CA_FILE/);
  const database = Object.assign(
    new Error("postgresql://user:private-password@example.com/db"),
    { code: "28P01" },
  );
  assert.equal(startupErrorDetails(database).code, "28P01");
  assert.equal(
    JSON.stringify(startupErrorDetails(database)).includes("private-password"),
    false,
  );
  assert.equal(
    JSON.stringify(startupErrorDetails(database)).includes("postgresql://"),
    false,
  );
  assert.equal(startupErrorDetails(null).code, "Error");
});

test("Output-only builds include runtime assets, exclude secrets/uploads and ignore cwd", async () => {
  const directory = await realpath(
    await mkdtemp(resolve(tmpdir(), "baotin-runtime-test-")),
  );
  try {
    const repository = resolve(directory, "repository");
    const script = "scripts/copy-runtime-assets.mjs";
    await mkdir(dirname(resolve(repository, script)), { recursive: true });
    await cp(resolve(script), resolve(repository, script));
    const fixtures = [
      ["certs/prod-ca-2021.crt", "public CA"],
      ["seed/mock.json", "{}"],
      ["media/images/locks/sample.jpg", "sample image"],
      ["media/uploads/private.webp", "private upload"],
      [".env", "PRIVATE_ENV=do-not-bundle"],
      ["dist/media/uploads/existing.webp", "keep existing upload"],
      ["assets/fonts/NotoSans.ttf", "test font"],
      ["assets/fonts/OFL.txt", "font license"],
    ];
    for (const [path, contents] of fixtures) {
      const destination = resolve(repository, path);
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, contents);
    }
    const build = spawnSync(process.execPath, [resolve(repository, script)], {
      cwd: directory,
      encoding: "utf8",
    });
    assert.equal(build.status, 0, build.stderr);
    for (const [path, contents] of fixtures.slice(0, 3)) {
      assert.equal(
        await readFile(resolve(repository, "dist", path), "utf8"),
        contents,
      );
    }
    assert.equal(existsSync(resolve(repository, "dist/.env")), false);
    assert.equal(
      await readFile(
        resolve(repository, "dist/assets/fonts/NotoSans.ttf"),
        "utf8",
      ),
      "test font",
    );
    assert.equal(
      await readFile(resolve(repository, "dist/assets/fonts/OFL.txt"), "utf8"),
      "font license",
    );
    assert.equal(
      existsSync(resolve(repository, "dist/media/uploads/private.webp")),
      false,
    );
    assert.equal(
      await readFile(
        resolve(repository, "dist/media/uploads/existing.webp"),
        "utf8",
      ),
      "keep existing upload",
    );

    const application = resolve(directory, "application");
    await cp(resolve(repository, "dist"), application, { recursive: true });
    const runtime = ts.transpileModule(
      await readFile("src/runtime-assets.ts", "utf8"),
      {
        compilerOptions: {
          module: ts.ModuleKind.CommonJS,
          target: ts.ScriptTarget.ES2022,
        },
      },
    ).outputText;
    const module = resolve(application, "runtime-assets.js");
    await writeFile(module, runtime);
    const paths = [
      "./certs/prod-ca-2021.crt",
      "seed/mock.json",
      "media",
      "assets/fonts/NotoSans.ttf",
      "/mounted/media",
    ];
    const probe = spawnSync(
      process.execPath,
      [
        "-e",
        `const { runtimeAssetPath } = require(${JSON.stringify(module)}); console.log(JSON.stringify(${JSON.stringify(paths)}.map(runtimeAssetPath)));`,
      ],
      { cwd: directory, encoding: "utf8" },
    );
    assert.equal(probe.status, 0, probe.stderr);
    assert.deepEqual(
      JSON.parse(probe.stdout),
      paths.map((path) => resolve(application, path)),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
