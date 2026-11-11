import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { build } from "esbuild";

const root = resolve("."),
  backend = join(root, ".desktop/backend");
if (!existsSync(".next/standalone/server.js"))
  throw new Error("Run npm run build before preparing desktop");
await rm(join(root, ".desktop"), { recursive: true, force: true });
await mkdir(backend, { recursive: true });
await cp(".next/standalone", backend, {
  recursive: true,
  filter: (source) => !/(^|[/\\])\.env(?:\.|$)|\.db(?:-|$)|\.pem$/.test(source),
});
for (const [source, destination] of [
  [".next/static", ".next/static"],
  ["public", "public"],
  ["prisma", "prisma"],
  ["scripts/migrate.mjs", "scripts/migrate.mjs"],
  ["desktop/server.mjs", "runtime/desktop-server.mjs"],
  ["desktop/security.cjs", "runtime/security.cjs"],
  ["LICENSE", "LICENSE"],
  ["NOTICE", "NOTICE"],
]) {
  await cp(source, join(backend, destination), {
    recursive: true,
    filter: (p) => !/\.db(?:-|$)/.test(p),
  });
}
// Next tracing does not see the dynamically spawned CLI or worker dependencies.
for (const name of [
  "@prisma",
  ".prisma",
  "prisma",
  "@openai/codex",
  "@openai/codex-sdk",
]) {
  await cp(join("node_modules", name), join(backend, "node_modules", name), {
    recursive: true,
  });
}
const target = process.env.TRACEFOLIO_DESKTOP_TARGET ?? process.platform;
const arch = process.env.TRACEFOLIO_DESKTOP_ARCH ?? process.arch;
const native =
  target === "darwin"
    ? `codex-darwin-${arch}`
    : target === "win32"
      ? `codex-win32-${arch}`
      : `codex-linux-${arch}`;
const nativePath = join("node_modules/@openai", native);
if (!existsSync(nativePath))
  throw new Error(
    `Missing target Codex runtime: ${native}. Build on the target OS/architecture.`,
  );
await cp(nativePath, join(backend, "node_modules/@openai", native), {
  recursive: true,
});
await build({
  entryPoints: ["desktop/worker.ts"],
  outfile: join(backend, "runtime/task-worker.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  external: ["@prisma/client", "@openai/codex", "@openai/codex-sdk"],
  banner: {
    js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);',
  },
});
const cloudUrl = process.env.TRACEFOLIO_DESKTOP_CLOUD_URL ?? "";
if (cloudUrl) {
  const url = new URL(cloudUrl);
  if (url.protocol !== "https:" || url.username || url.password)
    throw new Error("Packaged cloud URL must use HTTPS");
}
const config = {
  requireLicense: process.env.TRACEFOLIO_DESKTOP_REQUIRE_LICENSE === "1",
  cloudUrl,
};
if (config.requireLicense && !cloudUrl)
  throw new Error("Commercial desktop build requires a cloud URL");
await writeFile(
  join(backend, "desktop-config.json"),
  JSON.stringify(config, null, 2),
);
// Build staging must never contain developer secrets, DBs or career materials.
const pkg = JSON.parse(await readFile("package.json", "utf8"));
const appDir = join(root, ".desktop/app");
await mkdir(join(appDir, "desktop"), { recursive: true });
for (const source of [
  "desktop/main.cjs",
  "desktop/security.cjs",
  "LICENSE",
  "NOTICE",
])
  await cp(source, join(appDir, source));
await writeFile(
  join(appDir, "package.json"),
  JSON.stringify(
    {
      name: pkg.name,
      version: pkg.version,
      description: pkg.description,
      author: pkg.author,
      license: pkg.license,
      main: "desktop/main.cjs",
    },
    null,
    2,
  ),
);
console.log(
  `Prepared TRACEFOLIO ${pkg.version} desktop backend for ${target}/${arch}.`,
);
