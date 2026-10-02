module.exports = {
    preset: 'ts-jest/presets/default-esm',
    testEnvironment: 'jsdom',
    extensionsToTreatAsEsm: ['.ts'],
    setupFiles: ['<rootDir>/tests/setup.cjs'],
    testMatch: ['**/*.test.ts', '**/*.test.tsx'],
    // Disable automatic coverage collection for faster local runs and to avoid failing the suite
    // when new, uncovered files are added. Run `npm test -- --coverage` when you need a report.
    collectCoverage: false,
    moduleNameMapper: {
        '^(\\.+/.*)\\.js$': '$1',
        '^@mlc-ai/web-llm$': '<rootDir>/tests/mocks/web-llm.js',
        '^msgpackr$': '<rootDir>/node_modules/msgpackr/dist/node.cjs',
        '^ws$': '<rootDir>/tests/mocks/ws.js',
        '^uuid$': require.resolve('uuid'),
    },
    transform: {
        '^.+\\.[tj]sx?$': [
            'ts-jest',
            {
                useESM: true,
                tsconfig: 'tsconfig.json'
            },
        ],
    },
    transformIgnorePatterns: [
        'node_modules/(?!(uuid|@apollo|@modelcontextprotocol|langchain|@langchain)/)'
    ],
};
