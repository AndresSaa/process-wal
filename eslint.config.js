import eslint from "@eslint/js";
import eslintConfigPrettier from "eslint-config-prettier";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    // Unlike prettier, eslint does not read .gitignore, so the editor's local
    // history directory has to be excluded here too or it lints scratch copies
    // of every file that has ever been edited.
    ignores: ["coverage/**", "dist/**", ".history/**"],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Build scripts run in Node rather than the browser. Declared inline to
    // keep the `globals` package out of the dev dependencies for two names.
    files: ["scripts/**/*.mjs"],
    languageOptions: {
      globals: { console: "readonly", process: "readonly" },
    },
  },
  eslintConfigPrettier,
);
