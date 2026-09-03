import path from 'path';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

const rawPort = process.env.PORT || '3000';

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

const basePath = process.env.BASE_PATH || '/';

export default defineConfig({
  base: basePath,
  // Les greffons Replit (superposition d'erreurs, cartographe, bandeau de
  // développement) venaient du gabarit d'origine. Ils n'ont aucun rôle ici :
  // ils alourdissaient la chaîne de construction et le paquet de dépendances
  // pour une plateforme que ce projet n'utilise pas.
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, 'src'),
      '@assets': path.resolve(
        import.meta.dirname,
        '..',
        '..',
        'attached_assets',
      ),
    },
    dedupe: ['react', 'react-dom'],
  },
  root: path.resolve(import.meta.dirname),
  build: {
    outDir: path.resolve(import.meta.dirname, 'dist/public'),
    emptyOutDir: true,
    chunkSizeWarningLimit: 350,
    rollupOptions: {
      output: {
        // Le tableau de bord partait en un seul fichier de près d'un mégaoctet.
        // Sur une liaison qui coupe les gros transferts, ce fichier arrivait
        // tronqué : le module échouait, React ne montait jamais et l'écran
        // restait vide sur le fond bleu — d'où « tout bleu sans rien », que le
        // rafraîchissement corrigeait quand le transfert passait entier.
        //
        // Découper en morceaux réduit chaque requête bien en dessous du seuil,
        // permet au navigateur de les charger en parallèle et de ne re-télécharger
        // que ce qui change d'une version à l'autre.
        manualChunks(id) {
          if (!id.includes('node_modules')) return;
          // recharts et ses dépendances d3 pèsent à elles seules des centaines
          // de kilooctets, pour un seul écran : elles méritent leur morceau.
          if (/[\\/]node_modules[\\/](recharts|d3-|victory|internmap|delaunator|robust-predicates)/.test(id)) return 'charts';
          if (/[\\/]node_modules[\\/]react-dom[\\/]/.test(id)) return 'react-dom';
          if (/[\\/]node_modules[\\/](react|scheduler|react-is)[\\/]/.test(id)) return 'react';
          if (/[\\/]node_modules[\\/]lucide-react[\\/]/.test(id)) return 'icons';
          if (/[\\/]node_modules[\\/](@radix-ui|sonner|cmdk|vaul|embla-carousel|input-otp|react-day-picker|react-resizable-panels|next-themes)/.test(id)) return 'ui';
          return 'vendor';
        },
      },
    },
  },
  server: {
    port,
    strictPort: true,
    host: '0.0.0.0',
    allowedHosts: true,
    fs: {
      strict: true,
    },
    proxy: {
      // /xapi/* → https://vpnsxb.afrihall.com/api/*
      // On évite /api/* car l'artifact api-server Replit l'intercepte
      // avant que Vite puisse le proxifier.
      '/xapi': {
        target: 'https://vpnsxb.afrihall.com',
        changeOrigin: true,
        secure: true,
        rewrite: (path) => path.replace(/^\/xapi/, '/api'),
      },
    },
  },
  preview: {
    port,
    host: '0.0.0.0',
    allowedHosts: true,
  },
});
