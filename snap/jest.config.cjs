module.exports = {
  preset: '@metamask/snaps-jest',
  transform: {
    '^.+\\.tsx?$': ['ts-jest', { tsconfig: './tsconfig.json' }],
  },
};
