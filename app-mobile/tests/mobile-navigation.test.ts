import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, it } from 'node:test';
import { visibleConfigs } from '../components/ui/configPickerItems';
import { getThemeColors } from '../constants/colors';

const mobile = path.resolve(__dirname, '..');
const requireMobile = createRequire(path.join(mobile, 'package.json'));
const { build } = createRequire(requireMobile.resolve('tsx'))('esbuild');

type Button = { label: string; disabled: boolean; onPress(): void; onLongPress?(): void };
type Harness = {
  renderDock(language?: 'fr' | 'en', routes?: string[], selected?: number): string;
  renderPicker(configs: { id: string; name: string; protocol: string; isActive: boolean; status?: string }[], active: string,
    activeQuota?: { totalBytes: number; usedBytes: number; expiryDate: string | null }): string;
  state: {
    buttons: Button[];
    events: { type: string; target: string }[];
    navigations: string[];
    selections: string[];
    prevent: boolean;
  };
};
type PluginSetup = {
  onResolve(options: { filter: RegExp }, callback: (args: { path: string }) => unknown): void;
  onLoad(options: { filter: RegExp; namespace: string }, callback: (args: { path: string }) => unknown): void;
};

async function harness(): Promise<Harness> {
  const stubs: Record<string, string> = {
    'test:state': `export const state={buttons:[],events:[],navigations:[],selections:[],prevent:false};`,
    'react-native': `
      import React from 'react';
      import {state} from 'test:state';
      const primitive=tag=>({children,accessibilityRole,accessibilityLabel,accessibilityState})=>
        React.createElement(tag,{role:accessibilityRole,'aria-label':accessibilityLabel,'aria-selected':accessibilityState?.selected},children);
      export const View=primitive('div'),Text=primitive('span'),ScrollView=primitive('div'),ActivityIndicator=primitive('span');
      export const TextInput=({placeholder})=>React.createElement('input',{placeholder});
      export const Modal=({children,visible})=>visible?React.createElement('div',{},children):null;
      export const Alert={alert:()=>{}};
      export const Platform={OS:'web'};
      export const StyleSheet={create:x=>x,absoluteFillObject:{}};
      export const Pressable=({children,accessibilityLabel,accessibilityRole,accessibilityState,disabled,onPress,onLongPress})=>{
        state.buttons.push({label:accessibilityLabel,disabled:!!disabled,onPress,onLongPress});
        return React.createElement('button',{role:accessibilityRole,'aria-label':accessibilityLabel,'aria-selected':accessibilityState?.selected,disabled},
          typeof children==='function'?children({pressed:false}):children);
      };
      class Value { constructor(value){this.value=value} interpolate(){return this.value} }
      export const Animated={Value,View,createAnimatedComponent:x=>x};`,
    '@expo/vector-icons': `import React from 'react'; export const Ionicons=({name})=>React.createElement('i',{'data-icon':name});`,
    'expo-linear-gradient': `import React from 'react'; export const LinearGradient=({children})=>React.createElement('div',{},children);`,
    'react-native-safe-area-context': `export const useSafeAreaInsets=()=>({top:24,bottom:24,left:0,right:0});`,
    'expo-haptics': `export async function selectionAsync(){}`,
    '@/hooks/useMotionPreference': `export const useMotionPreference=()=>({reduceMotion:true,motionEnabled:false});`,
    '@/hooks/useColors': `export const useColors=()=>(${JSON.stringify({ ...getThemeColors('dark'), primaryForeground: '#06101D' })});`,
  };
  const output = await build({
    stdin: {
      contents: `
        import React from 'react';
        import {renderToStaticMarkup} from 'react-dom/server';
        import TabDock from './components/ui/TabDock';
        import ConfigPicker from './components/ui/ConfigPicker';
        import {LanguageContext} from './contexts/LanguageContext';
        import {state} from 'test:state';
        export {state};
        const render=(language,element)=>renderToStaticMarkup(React.createElement(LanguageContext.Provider,{value:{language}},element));
        export function renderDock(language='fr',names=['index','history','profile','notifications'],selected=0){
          state.buttons=[];
          const routes=names.map(name=>({name,key:name+'-key'}));
          return render(language,React.createElement(TabDock,{
            state:{routes,index:selected},
            descriptors:Object.fromEntries(routes.map(route=>[route.key,{options:{}}])),
            navigation:{
              emit:event=>{state.events.push(event);return {defaultPrevented:state.prevent}},
              navigate:name=>state.navigations.push(name),
            },
          }));
        }
        export function renderPicker(configs,active,activeQuota){
          state.buttons=[];
          return render('fr',React.createElement(ConfigPicker,{
            visible:true,onClose:()=>{},configs,activeConfigId:active,activeQuota,connections:[],switching:false,
            onSelect:id=>state.selections.push(id),onDelete:async()=>true,
          }));
        }`,
      loader: 'tsx',
      resolveDir: mobile,
    },
    bundle: true, write: false, platform: 'node', format: 'cjs', logLevel: 'silent',
    external: ['react', 'react-dom/server'],
    plugins: [{
      name: 'navigation-fixtures',
      setup(plugin: PluginSetup) {
        plugin.onResolve({ filter: /.*/ }, args => args.path in stubs ? { path: args.path, namespace: 'stub' } : undefined);
        plugin.onLoad({ filter: /.*/, namespace: 'stub' }, args => ({ contents: stubs[args.path], loader: 'js' }));
      },
    }],
  });
  const module = { exports: {} };
  runInNewContext(output.outputFiles[0].text, {
    module, exports: module.exports, require: requireMobile, console, setTimeout, clearTimeout, process,
  });
  return module.exports as Harness;
}

describe('mobile dock', () => {
  it('keeps four named tabs and exactly one selection in both languages', async () => {
    const h = await harness();
    for (const language of ['fr', 'en'] as const) {
      const markup = h.renderDock(language);
      assert.equal((markup.match(/role="tab"/g) || []).length, 4);
      assert.equal((markup.match(/aria-selected="true"/g) || []).length, 1);
      assert.match(markup, /role="tablist"/);
      assert.ok(h.state.buttons.every(button => button.label && !button.label.includes('_')));
    }
  });

  it('matches routes by name, not position, and preserves navigation events', async () => {
    const h = await harness();
    const markup = h.renderDock('en', ['notifications', 'index', 'history', 'profile'], 1);
    assert.equal(h.state.buttons[0].label, 'Alerts');
    assert.equal(h.state.buttons[1].label, 'Home');
    assert.match(markup, /data-icon="home"/);
    h.state.buttons[0].onPress();
    assert.deepEqual([...h.state.navigations], ['notifications']);
    assert.equal(h.state.events[0].target, 'notifications-key');
    h.state.buttons[0].onLongPress?.();
    assert.equal(h.state.events[1].type, 'tabLongPress');
  });

  it('does not navigate on a selected tab or when tabPress is prevented', async () => {
    const h = await harness();
    h.renderDock();
    h.state.buttons[0].onPress();
    assert.equal(h.state.navigations.length, 0);
    h.state.prevent = true;
    h.state.buttons[1].onPress();
    assert.equal(h.state.navigations.length, 0);
    assert.equal(h.state.events.length, 2);
  });
});

describe('connection picker', () => {
  const configs = [
    { id: 'b', name: 'Zone 10', protocol: 'vless', isActive: false },
    { id: 'c', name: 'Évasion', protocol: 'ssh', isActive: false },
    { id: 'a', name: 'Zone 2', protocol: 'trojan', isActive: true },
    { id: 'd', name: 'Suspendue', protocol: 'vmess', isActive: false, status: 'suspended' },
  ];

  it('places the active connection first without changing the stored ordering', () => {
    const ordered = visibleConfigs(configs, 'c', '', 'fr');
    assert.deepEqual(ordered.map(c => c.id), ['c', 'd', 'a', 'b']);
    assert.deepEqual(configs.map(c => c.id), ['b', 'c', 'a', 'd']);
  });

  it('searches names case-insensitively and without accents, never technical fields', () => {
    assert.deepEqual(visibleConfigs(configs, 'a', ' EVASION ', 'fr').map(c => c.id), ['c']);
    assert.equal(visibleConfigs(configs, 'a', 'ssh', 'en').length, 0);
    assert.equal(visibleConfigs(configs, 'a', 'unknown', 'en').length, 0);
    assert.deepEqual(visibleConfigs([], null, '', 'en'), []);
  });

  it('keeps selection and deletion distinct and does not reveal protocols', async () => {
    const h = await harness();
    const markup = h.renderPicker(configs, 'a');
    assert.doesNotMatch(markup, />\s*(vless|ssh|trojan|vmess)\s*</i);
    const active = h.state.buttons.find(button => button.label === 'Zone 2')!;
    assert.equal(active.disabled, true);
    assert.equal(h.state.buttons.find(button => button.label === 'Suspendue')!.disabled, true);
    const choice = h.state.buttons.find(button => button.label === 'Évasion')!;
    assert.equal(choice.disabled, false);
    choice.onPress();
    assert.deepEqual([...h.state.selections], ['c']);
    assert.equal(h.state.buttons.filter(button => button.label?.startsWith('Supprimer ')).length, configs.length);
  });

  it('uses the home quota for the active row only', async () => {
    const h = await harness();
    const markup = h.renderPicker(configs, 'a', { totalBytes: 1000, usedBytes: 200, expiryDate: null });
    assert.equal((markup.match(/800 B/g) || []).length, 1);
    assert.equal((markup.match(/1000 B/g) || []).length, 1);
  });
});
