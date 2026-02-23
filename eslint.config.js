import globals from "globals";
import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/", "data/", "public/", "bin/"] },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  { files: ["**/*.js"], languageOptions: { globals: globals.node } },
);
