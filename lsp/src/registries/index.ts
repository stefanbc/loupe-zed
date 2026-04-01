import type { RegistryHandler } from "../types";
import { npmHandler } from "./npm";
import { packagistHandler } from "./packagist";

export const registries: RegistryHandler[] = [npmHandler, packagistHandler];
