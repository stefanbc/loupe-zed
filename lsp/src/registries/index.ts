import type { RegistryHandler } from "../types";
import { npmHandler } from "./npm";
import { packagistHandler } from "./packagist";
import { pypiHandler } from "./pypi";

export const registries: RegistryHandler[] = [
	npmHandler,
	packagistHandler,
	pypiHandler,
];
