import React, { useEffect, useState } from "react";
import { useTranslation } from "../contexts/I18nContext";
import { fetchResellers, createReseller, updateReseller } from "../api/resellers";
import { fetchClients, createClient } from "../api/clients";
import { Reseller, Client, UserRole } from "../types";
import { ShieldCheck, Plus, Search, RefreshCw, Key, Landmark, UserPlus, Coins, UserCheck, Copy, CheckCheck, KeyRound } from "lucide-react";

interface ResellersViewProps {
  currentUserRole: UserRole;
  actorName: string;
}

// Modal affichant les identifiants générés après création d'un compte
function CredentialsModal({ credentials, onClose }: {
  credentials: { name: string; email: string; password: string; role: string };
  onClose: () => void;
}) {
  const [copiedEmail, setCopiedEmail] = useState(false);
  const [copiedPass, setCopiedPass] = useState(false);
  const [copiedAll, setCopiedAll] = useState(false);

  const copy = (text: string, setter: (v: boolean) => void) => {
    navigator.clipboard.writeText(text).then(() => {
      setter(true);
      setTimeout(() => setter(false), 2000);
    });
  };

  const copyAll = () => {
    const text = `Dashboard SXB VPN\nURL: https://vpnsxb.afrihall.com\nNom: ${credentials.name}\nEmail: ${credentials.email}\nMot de passe: ${credentials.password}\nRôle: ${credentials.role}`;
    copy(text, setCopiedAll);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm">
      <div className="w-full max-w-md p-6 bg-[#0a0d14] border border-[#1a2535] rounded-2xl shadow-2xl relative">
        {/* Header */}
        <div className="flex items-center gap-3 mb-5">
          <div className="w-10 h-10 rounded-xl bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center">
            <KeyRound className="h-5 w-5 text-emerald-400" />
          </div>
          <div>
            <h2 className="text-base font-bold text-white">Compte créé avec succès</h2>
            <p className="text-xs text-gray-400">Transmettez ces identifiants au revendeur</p>
          </div>
        </div>

        {/* Warning */}
        <div className="mb-4 p-3 rounded-lg bg-amber-500/10 border border-amber-500/20 text-xs text-amber-300">
          ⚠️ Le mot de passe ne sera plus affiché après fermeture. Copiez-le maintenant.
        </div>

        {/* Credentials */}
        <div className="space-y-3">
          <div>
            <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1">Nom</label>
            <div className="px-3 py-2 bg-[#0f1218] border border-[#1a1f2e] rounded-lg text-sm text-white font-medium">
              {credentials.name}
            </div>
          </div>

          <div>
            <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1">Email (identifiant)</label>
            <div className="flex gap-2">
              <div className="flex-1 px-3 py-2 bg-[#0f1218] border border-[#1a1f2e] rounded-lg text-sm text-cyan-400 font-mono">
                {credentials.email}
              </div>
              <button
                onClick={() => copy(credentials.email, setCopiedEmail)}
                className="px-3 py-2 rounded-lg bg-[#0f1218] border border-[#1a1f2e] text-gray-400 hover:text-white transition-colors"
              >
                {copiedEmail ? <CheckCheck size={14} className="text-emerald-400" /> : <Copy size={14} />}
              </button>
            </div>
          </div>

          <div>
            <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1">Mot de passe</label>
            <div className="flex gap-2">
              <div className="flex-1 px-3 py-2 bg-[#0f1218] border border-emerald-500/30 rounded-lg text-sm text-emerald-400 font-mono font-bold tracking-wide">
                {credentials.password}
              </div>
              <button
                onClick={() => copy(credentials.password, setCopiedPass)}
                className="px-3 py-2 rounded-lg bg-[#0f1218] border border-[#1a1f2e] text-gray-400 hover:text-white transition-colors"
              >
                {copiedPass ? <CheckCheck size={14} className="text-emerald-400" /> : <Copy size={14} />}
              </button>
            </div>
          </div>

          <div>
            <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1">URL Dashboard</label>
            <div className="px-3 py-2 bg-[#0f1218] border border-[#1a1f2e] rounded-lg text-sm text-gray-300 font-mono">
              https://vpnsxb.afrihall.com
            </div>
          </div>
        </div>

        {/* Actions */}
        <div className="flex gap-2 mt-5">
          <button
            onClick={copyAll}
            className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-[#5B8DEF] hover:bg-[#4a7de0] text-white text-sm font-semibold transition-colors"
          >
            {copiedAll ? <CheckCheck size={14} /> : <Copy size={14} />}
            {copiedAll ? "Copié !" : "Tout copier"}
          </button>
          <button
            onClick={onClose}
            className="flex-1 px-4 py-2.5 rounded-lg bg-[#0f1218] border border-[#1a1f2e] text-gray-300 hover:text-white text-sm font-semibold transition-colors"
          >
            Fermer
          </button>
        </div>
      </div>
    </div>
  );
}

export default function ResellersView({ currentUserRole, actorName }: ResellersViewProps) {
  const { t } = useTranslation();
  const [resellers, setResellers] = useState<Reseller[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  
  // Modals
  const [showAddReseller, setShowAddReseller] = useState(false);
  const [showAddResellerClient, setShowAddResellerClient] = useState(false);
  const [selectedResellerId, setSelectedResellerId] = useState<string | null>(null);
  const [createdCredentials, setCreatedCredentials] = useState<{ name: string; email: string; password: string; role: string } | null>(null);

  // Form states (Reseller)
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [balance, setBalance] = useState(500);

  // Form states (Reseller Client)
  const [clientName, setClientName] = useState("");
  const [clientEmail, setClientEmail] = useState("");

  const isReseller = currentUserRole === UserRole.RESELLER;
  const isSupport = currentUserRole === UserRole.SUPPORT;

  const loadResellers = async () => {
    setLoading(true);
    try {
      const data = await fetchResellers();
      setResellers(data);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadResellers();
  }, []);

  const handleCreateReseller = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name || !email) return;

    try {
      const result = await createReseller({
        name,
        email,
        balance: Number(balance),
        status: "active",
      }) as any;

      // Afficher les identifiants si un mot de passe a été généré
      if (result.generatedPassword) {
        setCreatedCredentials({
          name: result.name || name,
          email: result.email || email,
          password: result.generatedPassword,
          role: "RESELLER",
        });
      }

      setName("");
      setEmail("");
      setBalance(500);
      setShowAddReseller(false);
      loadResellers();
    } catch (err) {
      alert("Erreur lors de la création");
    }
  };

  const handleCreateResellerClient = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedResellerId || !clientName) return;

    try {
      await createClient({
        name: clientName,
        email: clientEmail || undefined,
      });

      setClientName("");
      setClientEmail("");
      setShowAddResellerClient(false);
      loadResellers();
    } catch (err) {
      alert(err instanceof Error ? err.message : t("common.error_generic"));
    }
  };

  const handleAdjustBalance = async (id: string, currentBalance: number) => {
    const promptAmount = prompt("Saisir la quantité de crédit en Go à attribuer (positif pour ajouter, négatif pour retirer) :");
    if (promptAmount === null) return;
    const amount = Number(promptAmount);
    if (isNaN(amount)) return alert("Veuillez saisir un nombre valide");

    try {
      await updateReseller(id, { balance: Math.max(0, currentBalance + amount) });
      loadResellers();
    } catch (err) {
      alert("Erreur lors de l'attribution des crédits");
    }
  };

  const filtered = resellers.filter((r) => {
    return (r.name || "").toLowerCase().includes(search.toLowerCase()) || 
           (r.email || "").toLowerCase().includes(search.toLowerCase());
  });

  if (isReseller) {
    return (
      <div className="border border-gray-800 rounded-xl p-8 bg-gray-950/20 backdrop-blur-md text-center max-w-lg mx-auto">
        <Landmark className="h-10 w-10 text-cyan-400 mx-auto mb-3" />
        <h2 className="text-lg font-bold text-white">Espace Revendeur</h2>
        <p className="text-sm text-gray-400 mt-2 leading-relaxed">
          En tant que revendeur, vous n'avez pas accès à la liste globale des autres revendeurs du réseau. Vous pouvez toutefois directement créer des clients VPN depuis l'onglet <strong>Gestion Clients</strong> qui consommeront votre crédit de tokens.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Credentials modal après création */}
      {createdCredentials && (
        <CredentialsModal
          credentials={createdCredentials}
          onClose={() => setCreatedCredentials(null)}
        />
      )}

      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-white">{t("resellers.title")}</h1>
          <p className="text-sm text-gray-400 mt-1">{t("resellers.subtitle")}</p>
        </div>

        {!isSupport && (
          <button
            onClick={() => setShowAddReseller(true)}
            className="flex items-center gap-2 px-4 py-2 bg-gradient-to-r from-cyan-500 to-blue-600 hover:from-cyan-400 hover:to-blue-500 text-white font-medium text-sm rounded-lg shadow-lg shadow-cyan-950/20 transition-all cursor-pointer"
          >
            <Plus className="h-4 w-4" />
            {t("resellers.add_reseller")}
          </button>
        )}
      </div>

      {/* Search */}
      <div className="relative w-full md:w-80">
        <Search className="absolute left-3 top-2.5 h-4.5 w-4.5 text-gray-500" />
        <input
          type="text"
          placeholder="Rechercher un revendeur..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full pl-10 pr-4 py-2 text-sm bg-gray-900 border border-gray-800 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-cyan-500/50"
        />
      </div>

      {/* Table */}
      {loading ? (
        <div className="flex flex-col items-center justify-center py-20 text-gray-400">
          <RefreshCw className="h-7 w-7 animate-spin text-cyan-400 mb-4" />
          <p className="text-sm font-mono">{t("common.loading")}</p>
        </div>
      ) : filtered.length > 0 ? (
        <div className="border border-gray-800/80 rounded-xl bg-gray-950/20 overflow-hidden backdrop-blur-md">
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-gray-800/80 bg-gray-900/40 text-xs font-semibold text-gray-400 uppercase tracking-wider">
                  <th className="py-3 px-4">{t("resellers.fields.name")}</th>
                  <th className="py-3 px-4">{t("resellers.fields.email")}</th>
                  <th className="py-3 px-4">{t("resellers.fields.balance")}</th>
                  <th className="py-3 px-4 text-center">{t("resellers.fields.clients_count")}</th>
                  <th className="py-3 px-4 text-center">{t("resellers.fields.status")}</th>
                  <th className="py-3 px-4">{t("resellers.fields.created_at")}</th>
                  {!isSupport && <th className="py-3 px-4 text-right">{t("common.actions")}</th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-900 text-sm">
                {filtered.map((r) => (
                  <tr key={r.id} className="hover:bg-gray-900/20 transition-colors">
                    <td className="py-4 px-4 font-medium text-white">
                      <div className="flex items-center gap-2">
                        <UserCheck className="h-4 w-4 text-cyan-400 shrink-0" />
                        {r.name}
                      </div>
                    </td>
                    <td className="py-4 px-4 text-gray-400">{r.email}</td>
                    <td className="py-4 px-4 font-mono font-semibold text-cyan-400">{r.balance} Go</td>
                    <td className="py-4 px-4 text-center text-white">{r.clientsCount}</td>
                    <td className="py-4 px-4 text-center">
                      <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold ${
                        r.status === "active" 
                          ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20"
                          : "bg-amber-500/10 text-amber-400 border border-amber-500/20"
                      }`}>
                        {r.status === "active" ? "Actif" : "Suspendu"}
                      </span>
                    </td>
                    <td className="py-4 px-4 text-xs text-gray-500 font-mono">
                      {new Date(r.createdAt).toLocaleDateString()}
                    </td>
                    {!isSupport && (
                      <td className="py-4 px-4 text-right">
                        <div className="flex justify-end gap-2">
                          <button
                            onClick={() => handleAdjustBalance(r.id, r.balance)}
                            className="flex items-center gap-1 px-2.5 py-1 text-xs font-semibold rounded bg-cyan-950 text-cyan-400 hover:bg-cyan-900/50 border border-cyan-800/20 cursor-pointer"
                          >
                            <Coins className="h-3.5 w-3.5" /> Allouer
                          </button>
                          <button
                            onClick={() => {
                              setSelectedResellerId(r.id);
                              setShowAddResellerClient(true);
                            }}
                            className="flex items-center gap-1 px-2.5 py-1 text-xs font-semibold rounded bg-blue-950 text-blue-400 hover:bg-blue-900/50 border border-blue-800/20 cursor-pointer"
                          >
                            <UserPlus className="h-3.5 w-3.5" /> Client
                          </button>
                        </div>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        <div className="border border-dashed border-gray-800 rounded-xl p-12 text-center bg-gray-950/10">
          <ShieldCheck className="h-12 w-12 text-gray-700 mx-auto mb-4" />
          <h3 className="text-base font-semibold text-white">{t("resellers.empty_state")}</h3>
          <p className="text-sm text-gray-400 max-w-sm mx-auto mt-1">{t("resellers.empty_state_desc")}</p>
          {!isSupport && (
            <button
              onClick={() => setShowAddReseller(true)}
              className="mt-5 px-4 py-2 text-xs font-semibold rounded-lg bg-cyan-950 text-cyan-400 border border-cyan-800/40 hover:bg-cyan-900/50 transition-all cursor-pointer"
            >
              Inviter un revendeur partenaire
            </button>
          )}
        </div>
      )}

      {/* Modal Créer Revendeur */}
      {showAddReseller && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm">
          <div className="w-full max-w-md p-6 bg-gray-950 border border-gray-800 rounded-xl shadow-2xl relative">
            <h2 className="text-lg font-bold text-white mb-1 flex items-center gap-2">
              <Plus className="h-5 w-5 text-cyan-400" />
              {t("resellers.add_reseller")}
            </h2>
            <p className="text-xs text-gray-500 mb-4">Un compte dashboard sera créé automatiquement avec un mot de passe généré.</p>
            
            <form onSubmit={handleCreateReseller} className="space-y-4">
              <div>
                <label className="block text-xs font-semibold text-gray-400 mb-1.5 uppercase tracking-wider">{t("resellers.fields.name")}</label>
                <input
                  type="text"
                  required
                  placeholder="Nom de la société / du partenaire"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="w-full px-3 py-2 text-sm bg-gray-900 border border-gray-800 rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-cyan-500/50"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-gray-400 mb-1.5 uppercase tracking-wider">{t("resellers.fields.email")}</label>
                <input
                  type="email"
                  required
                  placeholder="contact@partenaire.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="w-full px-3 py-2 text-sm bg-gray-900 border border-gray-800 rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-cyan-500/50"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-gray-400 mb-1.5 uppercase tracking-wider">Allocation de crédits initiaux (Go)</label>
                <input
                  type="number"
                  required
                  min="0"
                  value={balance}
                  onChange={(e) => setBalance(Number(e.target.value))}
                  className="w-full px-3 py-2 text-sm bg-gray-900 border border-gray-800 rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-cyan-500/50"
                />
              </div>

              <div className="flex gap-2 justify-end mt-6 pt-4 border-t border-gray-900">
                <button
                  type="button"
                  onClick={() => setShowAddReseller(false)}
                  className="px-4 py-2 text-xs font-semibold rounded-lg bg-gray-900 text-gray-400 hover:bg-gray-800 cursor-pointer"
                >
                  {t("common.cancel")}
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 text-xs font-semibold rounded-lg bg-cyan-500 hover:bg-cyan-400 text-black shadow-lg shadow-cyan-950/20 cursor-pointer"
                >
                  Créer le compte
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Modal Créer Client Revendeur */}
      {showAddResellerClient && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm">
          <div className="w-full max-w-md p-6 bg-gray-950 border border-gray-800 rounded-xl shadow-2xl relative">
            <h2 className="text-lg font-bold text-white mb-4 flex items-center gap-2">
              <UserPlus className="h-5 w-5 text-blue-400" />
              Créer un client (via Revendeur)
            </h2>
            
            <form onSubmit={handleCreateResellerClient} className="space-y-4">
              <div>
                <label className="block text-xs font-semibold text-gray-400 mb-1.5 uppercase tracking-wider">Nom complet du client</label>
                <input
                  type="text"
                  required
                  placeholder="Marie Durand"
                  value={clientName}
                  onChange={(e) => setClientName(e.target.value)}
                  className="w-full px-3 py-2 text-sm bg-gray-900 border border-gray-800 rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-cyan-500/50"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-gray-400 mb-1.5 uppercase tracking-wider">Adresse Email (optionnel)</label>
                <input
                  type="email"
                  placeholder="marie@gmail.com"
                  value={clientEmail}
                  onChange={(e) => setClientEmail(e.target.value)}
                  className="w-full px-3 py-2 text-sm bg-gray-900 border border-gray-800 rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-cyan-500/50"
                />
              </div>

              <p className="text-xs text-gray-500 mt-2">
                Le quota sera défini lors de la création du token/forfait pour ce client.
              </p>

              <div className="flex gap-2 justify-end mt-6 pt-4 border-t border-gray-900">
                <button
                  type="button"
                  onClick={() => setShowAddResellerClient(false)}
                  className="px-4 py-2 text-xs font-semibold rounded-lg bg-gray-900 text-gray-400 hover:bg-gray-800 cursor-pointer"
                >
                  {t("common.cancel")}
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 text-xs font-semibold rounded-lg bg-blue-500 hover:bg-blue-400 text-black shadow-lg shadow-blue-950/20 cursor-pointer"
                >
                  Déduire & Créer
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
