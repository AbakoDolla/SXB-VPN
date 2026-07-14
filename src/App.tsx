import { useEffect, useState } from "react";
import { I18nProvider, useTranslation } from "./contexts/I18nContext";
import { getSessionUser } from "./api/auth";
import { User, UserRole } from "./types";
import Layout from "./components/Layout";
import DashboardView from "./components/DashboardView";
import ClientsView from "./components/ClientsView";
import ResellersView from "./components/ResellersView";
import XPanelView from "./components/XPanelView";
import ServersView from "./components/ServersView";
import TokensView from "./components/TokensView";
import VouchersView from "./components/VouchersView";
import RBACView from "./components/RBACView";
import SettingsView from "./components/SettingsView";
import SupportView from "./components/SupportView";
import { ShieldAlert, RefreshCw } from "lucide-react";

function MainApp() {
  const { t } = useTranslation();
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [activeRoute, setActiveRoute] = useState("dashboard");
  const [loading, setLoading] = useState(true);

  const fetchUserSession = async () => {
    try {
      const user = await getSessionUser();
      setCurrentUser(user);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchUserSession();
  }, []);

  const handleUserChanged = (updatedUser: User) => {
    setCurrentUser(updatedUser);
  };

  const handleRolePermissionsUpdated = async () => {
    // Re-fetch user session to grab newly updated role permissions maps from DB
    await fetchUserSession();
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-[#07090e] flex flex-col items-center justify-center text-gray-400">
        <RefreshCw className="h-8 w-8 animate-spin text-cyan-400 mb-4" />
        <p className="text-sm font-mono">Chargement du dashboard SXB VPN...</p>
      </div>
    );
  }

  if (!currentUser) {
    return (
      <div className="min-h-screen bg-[#07090e] flex flex-col items-center justify-center text-gray-400">
        <ShieldAlert className="h-10 w-10 text-rose-500 mb-4" />
        <p className="text-sm font-semibold">Erreur d'authentification de session.</p>
      </div>
    );
  }

  // RBAC Client-Side Route guard checks
  const renderView = () => {
    const role = currentUser.role;

    switch (activeRoute) {
      case "dashboard":
        return <DashboardView onNavigate={(route) => setActiveRoute(route)} />;
      case "clients":
        return <ClientsView currentUserRole={role} actorName={currentUser.name} />;
      case "resellers":
        return <ResellersView currentUserRole={role} actorName={currentUser.name} />;
      case "servers":
        return <ServersView currentUserRole={role} />;
      case "xpanel":
        return <XPanelView currentUserRole={role} />;
      case "tokens":
        return <TokensView currentUserRole={role} />;
      case "vouchers":
        return <VouchersView currentUserRole={role} />;
      case "support":
        return <SupportView />;
      case "rbac":
        return (
          <RBACView 
            currentUserRole={role} 
            onRolePermissionsUpdated={handleRolePermissionsUpdated} 
          />
        );
      case "settings":
        return <SettingsView />;
      default:
        return <DashboardView onNavigate={(route) => setActiveRoute(route)} />;
    }
  };

  return (
    <Layout
      activeRoute={activeRoute}
      onNavigate={(route) => setActiveRoute(route)}
      currentUser={currentUser}
      onUserChanged={handleUserChanged}
    >
      {renderView()}
    </Layout>
  );
}

export default function App() {
  return (
    <I18nProvider>
      <MainApp />
    </I18nProvider>
  );
}
