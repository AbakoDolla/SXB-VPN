const { parseVersionCode } = require('./scripts/android-version.cjs');

module.exports = ({ config }) => {
  const distribution = process.env.EXPO_PUBLIC_DISTRIBUTION || 'direct';
  if (!['direct', 'play'].includes(distribution)) {
    throw new Error('EXPO_PUBLIC_DISTRIBUTION must be direct or play');
  }
  const projectId = process.env.EAS_PROJECT_ID;
  if (projectId && !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(projectId)) {
    throw new Error('EAS_PROJECT_ID must be the real Expo project UUID');
  }
  return {
    ...config,
    android: {
      ...config.android,
      ...(process.env.SXB_ANDROID_VERSION_CODE
        ? { versionCode: parseVersionCode(process.env.SXB_ANDROID_VERSION_CODE) }
        : {}),
    },
    extra: {
      ...config.extra,
      distribution,
      ...(projectId ? { eas: { ...config.extra?.eas, projectId } } : {}),
    },
  };
};
