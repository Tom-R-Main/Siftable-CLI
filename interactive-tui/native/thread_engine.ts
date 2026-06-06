import { fileURLToPath } from "node:url";

const suffix =
  process.platform === "darwin" ? "dylib" : process.platform === "win32" ? "dll" : "so";

export default fileURLToPath(new URL(`./libthread_engine.${suffix}`, import.meta.url));
