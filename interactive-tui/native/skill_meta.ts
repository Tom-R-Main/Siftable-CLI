import { fileURLToPath } from "node:url";

const suffix =
  process.platform === "darwin" ? "dylib" : process.platform === "win32" ? "dll" : "so";

export default fileURLToPath(new URL(`./libskill_meta.${suffix}`, import.meta.url));
