import assert from 'node:assert/strict';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const depot = path.resolve(__dirname, '..', '..');
const lire = (chemin: string) => readFileSync(path.join(depot, chemin), 'utf8');

describe('responsive mobile layout', () => {
  it('centralise les règles de breakpoint dans un seul hook partagé', () => {
    const hook = lire('app-mobile/hooks/useResponsive.ts');
    assert.match(hook, /useWindowDimensions/);
    assert.match(hook, /width < breakpoints\.compact/);
    assert.match(hook, /width >= breakpoints\.large/);
    assert.match(hook, /contentMaxWidth: isLarge \? responsiveLayout\.contentMaxWidth : undefined/);
    assert.match(hook, /quickActionColumns: isLarge \? 4 : 2/);
    assert.match(hook, /statColumns: isLarge \? 4 : scaledCompact \? 2 : 3/);
  });

  it('applique le centrage et le padding responsive aux écrans clés', () => {
    for (const fichier of [
      'app-mobile/app/(tabs)/index.tsx',
      'app-mobile/app/(tabs)/profile.tsx',
      'app-mobile/app/(tabs)/history.tsx',
      'app-mobile/app/(tabs)/notifications.tsx',
      'app-mobile/app/activate.tsx',
      'app-mobile/app/free-trial.tsx',
      'app-mobile/app/plan.tsx',
      'app-mobile/app/support.tsx',
    ]) {
      const source = lire(fichier);
      assert.match(source, /useResponsive\(/, `${fichier} : fondation responsive absente`);
      assert.match(source, /paddingHorizontal: responsive\.screenPadding/, `${fichier} : padding figé`);
      assert.match(source, /maxWidth:/, `${fichier} : contenu large non borné`);
      assert.match(source, /alignSelf: "center"/, `${fichier} : contenu non centré`);
    }
  });

  it('évite les rangées fixes qui tronquent en 320 dp', () => {
    assert.match(lire('app-mobile/app/free-trial.tsx'), /flexDirection: responsive\.isCompact \? "column" : "row"/);
    assert.match(lire('app-mobile/app/(tabs)/index.tsx'), /flexWrap: "wrap"/);
    assert.match(lire('app-mobile/app/(tabs)/profile.tsx'), /flexBasis: responsive\.isLarge \? "48%" : "100%"/);
    assert.match(lire('app-mobile/app/(tabs)/notifications.tsx'), /flexWrap: "wrap"/);
  });
});
