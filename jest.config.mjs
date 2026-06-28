const config = {
	preset: "ts-jest",
	clearMocks: true,
	testPathIgnorePatterns: [
		"/node_modules/",
		"/dist/",
	],
	moduleNameMapper: {
		"^(\\.{1,2}/.*)\\.js$": "$1",
	},
	transform: {},
};

export default config;
