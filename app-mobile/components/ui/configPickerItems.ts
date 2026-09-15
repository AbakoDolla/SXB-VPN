type NamedConfig = { id: string; name: string };

function searchKey(value: string) {
  return value.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLocaleLowerCase();
}

export function visibleConfigs<T extends NamedConfig>(
  configs: readonly T[],
  activeConfigId: string | null,
  query: string,
  language: 'fr' | 'en',
): T[] {
  const key = searchKey(query.trim());
  return configs
    .filter(config => searchKey(config.name).includes(key))
    .sort((a, b) =>
      Number(b.id === activeConfigId) - Number(a.id === activeConfigId)
      || a.name.localeCompare(b.name, language, { sensitivity: 'base', numeric: true }),
    );
}
