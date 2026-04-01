import type { RegistryHandler } from "../types";
import { npmHandler } from "./npm";

export const registries: RegistryHandler[] = [npmHandler];
