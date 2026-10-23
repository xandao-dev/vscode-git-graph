import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite-plus';

const FS_WITH_FALLBACK = '\0fs-with-fallback';

/**
 * Electron overrides the Node.js File System Module with its own version (which treats .asar files as directories).
 * Resolve every import of "fs" in the back-end to the Node.js version ("original-fs") when it's available.
 */
const originalFsPlugin = {
	name: 'git-graph:original-fs',
	resolveId(id: string, importer: string | undefined) {
		if ((id === 'fs' || id === 'node:fs') && importer !== FS_WITH_FALLBACK) return FS_WITH_FALLBACK;
		if (id === 'original-fs') return { id, external: true };
		return null;
	},
	load(id: string) {
		if (id !== FS_WITH_FALLBACK) return null;
		return 'try { module.exports = require("original-fs"); } catch (_) { module.exports = require("fs"); }';
	}
};

export default defineConfig(({ mode }) => ({
	// Front-end (Webview): `vp build`
	build: {
		outDir: 'media',
		emptyOutDir: true,
		target: 'chrome122', // Chromium version used by the minimum supported version of Visual Studio Code (1.90)
		minify: mode !== 'development',
		sourcemap: mode === 'development' ? 'inline' : false,
		cssCodeSplit: false,
		copyPublicDir: false,
		rolldownOptions: {
			input: 'web/main.ts',
			output: {
				format: 'iife',
				entryFileNames: 'out.min.js',
				assetFileNames: 'out.min[extname]'
			}
		}
	},

	// Back-end (Extension Host): `vp pack`
	pack: {
		// All entries are output to the same directory, as the code relies on `__dirname` to locate the askpass scripts and the life cycle data directory
		entry: {
			extension: 'src/extension.ts',
			askpassMain: 'src/askpass/askpassMain.ts',
			uninstall: 'src/life-cycle/uninstall.ts'
		},
		outDir: 'out',
		format: 'cjs',
		platform: 'node',
		target: 'node20', // Node.js version used by the minimum supported version of Visual Studio Code (1.90)
		fixedExtension: false,
		sourcemap: true,
		dts: false,
		deps: { neverBundle: ['vscode'] },
		copy: [{ from: 'src/askpass/*.sh', to: 'out', flatten: true }],
		plugins: [originalFsPlugin]
	},

	// Formatting: `vp fmt`
	fmt: {
		ignorePatterns: ['media/**', 'out/**', 'coverage/**', '**/*.md', '**/*.json', '**/*.yml', '**/*.css', '.vscode/**'],
		printWidth: 200,
		useTabs: true,
		singleQuote: true,
		quoteProps: 'preserve',
		trailingComma: 'none',
		endOfLine: 'crlf'
	},

	// Linting & Type Checking: `vp lint` / `vp check`
	lint: {
		ignorePatterns: ['media/**', 'out/**', 'coverage/**', '.vscode/**'],
		options: { typeAware: true, typeCheck: true },
		categories: { correctness: 'off' },
		rules: {
			'eqeqeq': 'warn',
			'new-cap': 'warn',
			'no-alert': 'error',
			'no-console': 'error',
			'no-eval': 'error',
			'no-extra-boolean-cast': 'warn',
			'no-global-assign': 'error',
			'no-irregular-whitespace': 'warn',
			'no-labels': 'error',
			'no-proto': 'error',
			'no-prototype-builtins': 'error',
			'no-script-url': 'error',
			'no-shadow-restricted-names': 'error',
			'no-sparse-arrays': 'warn',
			'no-throw-literal': 'warn',
			'no-unneeded-ternary': 'warn',
			'no-unsafe-negation': 'warn',
			'no-unused-expressions': 'warn',
			'no-var': 'warn',
			'no-with': 'error',
			'sort-imports': ['warn', { allowSeparatedGroups: true, ignoreDeclarationSort: true }],
			'yoda': 'warn',
			'typescript/await-thenable': 'warn',
			'typescript/ban-ts-comment': 'error',
			'typescript/class-literal-property-style': ['warn', 'fields'],
			'typescript/explicit-member-accessibility': ['warn', { overrides: { accessors: 'off', constructors: 'off' } }],
			'typescript/method-signature-style': ['warn', 'property'],
			'typescript/no-implied-eval': 'error',
			'typescript/no-misused-new': 'warn',
			'typescript/no-this-alias': 'warn',
			'typescript/no-unnecessary-boolean-literal-compare': 'warn',
			'typescript/return-await': 'warn'
		},
		overrides: [
			{ files: ['src/askpass/*.ts'], rules: { 'no-console': 'off' } },
			{ files: ['tests/mocks/*.ts'], rules: { 'no-global-assign': 'off' } }
		]
	},

	// Unit Tests: `vp test`
	test: {
		include: ['tests/**/*.test.ts'],
		globals: true,
		alias: { vscode: fileURLToPath(new URL('./tests/mocks/vscode.ts', import.meta.url)) },
		coverage: { include: ['src/utils/*.ts', 'src/*.ts'] }
	}
}));
