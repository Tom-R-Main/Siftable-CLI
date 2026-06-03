import { suffix } from "bun:ffi";

const module = await import(`./libcomposer_policy.${suffix}`, { with: { type: "file" } });

export default module.default as string;
