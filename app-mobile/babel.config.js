module.exports = function (api) {
  api.cache(true);
  return {
    presets: [['babel-preset-expo', { unstable_transformImportMeta: true }]],
    plugins: [
      // Required for react-native-reanimated 4.x + react-native-worklets 0.6.x
      // Must be last in the plugins list
      'react-native-worklets/plugin',
    ],
  };
};
