import { fileURLToPath } from "node:url";

const suffix =
  process.platform === "darwin" ? "dylib" : process.platform === "win32" ? "dll" : "so";

export default fileURLToPath(new URL(`./libcomposer_policy.${suffix}`, import.meta.url));
