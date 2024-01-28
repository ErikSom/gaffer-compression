const config = {
	preset: "ts-jest",
	clearMocks: true,
	testPathIgnorePatterns: [
		"/node_modules/",
		"/dist/",
	],
	transform: {},
};

export default config;
