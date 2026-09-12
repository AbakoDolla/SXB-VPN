import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { afterEach, before, beforeEach, describe, it } from "node:test";
import express from "express";
import bcrypt from "bcryptjs";

process.env.NODE_ENV = "test";
process.env.DATABASE_URL = "";

let authRouter: express.Router;
let usersRouter: express.Router;
let rbacRouter: express.Router;
let clientsRouter: express.Router;
let inMemoryDb: typeof import("../database").inMemoryDb;

const IDS = {
  roles: {
    OWNER: "00000000-0000-4000-8000-000000000001",
    SUPER_ADMIN: "00000000-0000-4000-8000-000000000002",
    ADMIN: "00000000-0000-4000-8000-000000000003",
    SUPPORT: "00000000-0000-4000-8000-000000000004",
    RESELLER: "00000000-0000-4000-8000-000000000005",
    CLIENT: "00000000-0000-4000-8000-000000000006",
  },
  users: {
    owner: "10000000-0000-4000-8000-000000000001",
    super: "10000000-0000-4000-8000-000000000002",
    admin: "10000000-0000-4000-8000-000000000003",
    support: "10000000-0000-4000-8000-000000000004",
    reseller: "10000000-0000-4000-8000-000000000005",
    client: "10000000-0000-4000-8000-000000000006",
    otherClient: "10000000-0000-4000-8000-000000000007",
  },
  reseller: "20000000-0000-4000-8000-000000000001",
};

const ROLE_DESCRIPTIONS: Record<string, string> = {
  OWNER: "Racine",
  SUPER_ADMIN: "Super administration",
  ADMIN: "Administration",
  SUPPORT: "Support lecture seule",
  RESELLER: "Revendeur",
  CLIENT: "Client VPN",
};

const PERMISSIONS = [
  "users.view",
  "users.create",
  "users.delete",
  "rbac.manage",
  "clients.view",
  "clients.create",
  "tokens.manage",
  "subscription.view",
  "subscription.manage",
  "audit.view",
] as const;

const ROLE_PERMISSIONS: Record<string, string[]> = {
  OWNER: [],
  SUPER_ADMIN: [...PERMISSIONS],
  ADMIN: ["users.view", "users.create", "clients.view", "clients.create", "subscription.view"],
  SUPPORT: ["users.view", "clients.view"],
  RESELLER: ["clients.view", "clients.create"],
  CLIENT: [],
};

const PASSWORDS = {
  owner: "Owner!12345",
  super: "Super!12345",
  admin: "Admin!12345",
  support: "Support!12345",
  reseller: "Reseller!12345",
  client: "Client!12345",
};

let server: Server | null = null;
let baseUrl = "";

before(async () => {
  const modules = await Promise.all([
    import("../routes/auth"),
    import("../routes/users"),
    import("../routes/rbac"),
    import("../routes/clients"),
    import("../database"),
  ]);
  authRouter = modules[0].default;
  usersRouter = modules[1].default;
  rbacRouter = modules[2].default;
  clientsRouter = modules[3].default;
  inMemoryDb = modules[4].inMemoryDb;
});

function roleId(name: keyof typeof IDS.roles) {
  return IDS.roles[name];
}

function permissionsDuRole(role: keyof typeof ROLE_PERMISSIONS) {
  return [...ROLE_PERMISSIONS[role]].sort();
}

function resetInMemoryDb() {
  const now = new Date();
  const future = new Date(Date.now() + 30 * 24 * 3600 * 1000);

  inMemoryDb.roles = Object.entries(IDS.roles).map(([name, id]) => ({
    id,
    name,
    description: ROLE_DESCRIPTIONS[name],
  }));
  inMemoryDb.permissions = PERMISSIONS.map((name, index) => ({
    id: `perm-${String(index + 1).padStart(2, "0")}`,
    name,
    description: name,
  }));
  inMemoryDb.rolePermissions = [];
  for (const [role, permissions] of Object.entries(ROLE_PERMISSIONS)) {
    const id = IDS.roles[role as keyof typeof IDS.roles];
    for (const permissionName of permissions) {
      const permission = inMemoryDb.permissions.find((item) => item.name === permissionName);
      if (permission) inMemoryDb.rolePermissions.push({ roleId: id, permissionId: permission.id });
    }
  }

  const user = (
    id: string,
    name: string,
    email: string,
    password: string,
    role: keyof typeof IDS.roles,
  ) => ({
    id,
    name,
    email,
    phone: null,
    passwordHash: bcrypt.hashSync(password, 10),
    roleId: roleId(role),
    status: "active",
    createdAt: now,
    updatedAt: now,
  });

  inMemoryDb.users = [
    user(IDS.users.owner, "Propriétaire", "owner.admin-roles@sxb.local", PASSWORDS.owner, "OWNER"),
    user(IDS.users.super, "Super Admin", "super.admin-roles@sxb.local", PASSWORDS.super, "SUPER_ADMIN"),
    user(IDS.users.admin, "Admin", "admin.admin-roles@sxb.local", PASSWORDS.admin, "ADMIN"),
    user(IDS.users.support, "Support", "support.admin-roles@sxb.local", PASSWORDS.support, "SUPPORT"),
    user(IDS.users.reseller, "Revendeur", "reseller.admin-roles@sxb.local", PASSWORDS.reseller, "RESELLER"),
    user(IDS.users.client, "Client", "client.admin-roles@sxb.local", PASSWORDS.client, "CLIENT"),
    user(IDS.users.otherClient, "Client autre", "other.admin-roles@sxb.local", "Other!12345", "CLIENT"),
  ];
  inMemoryDb.resellers = [{
    id: IDS.reseller,
    userId: IDS.users.reseller,
    commission: 0,
    status: "active",
    quotaBytes: BigInt(-1),
    quotaUsedBytes: BigInt(0),
    accessExpiresAt: future,
    createdAt: now,
    updatedAt: now,
  }];
  inMemoryDb.vpnClients = [
    {
      id: "client-own-explicit",
      userId: IDS.users.client,
      token: "SXB-OWN-EXPLICIT",
      quotaTotal: BigInt(1024),
      quotaUsed: BigInt(0),
      expireAt: future,
      deviceId: "device-client",
      activatedAt: now,
      deviceLimit: 1,
      resellerId: IDS.reseller,
      status: "active",
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "client-own-historical",
      userId: IDS.users.reseller,
      token: "SXB-OWN-HISTORICAL",
      quotaTotal: BigInt(1024),
      quotaUsed: BigInt(0),
      expireAt: future,
      deviceId: null,
      activatedAt: null,
      deviceLimit: 1,
      resellerId: null,
      status: "active",
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "client-other-reseller",
      userId: IDS.users.otherClient,
      token: "SXB-OTHER-RESELLER",
      quotaTotal: BigInt(1024),
      quotaUsed: BigInt(0),
      expireAt: future,
      deviceId: null,
      activatedAt: null,
      deviceLimit: 1,
      resellerId: "20000000-0000-4000-8000-000000000099",
      status: "active",
      createdAt: now,
      updatedAt: now,
    },
  ];
  inMemoryDb.auditLogs = [];
  inMemoryDb.tokens = [];
  inMemoryDb.vouchers = [];
  inMemoryDb.subscriptions = [];
}

function app() {
  const application = express();
  application.set("json replacer", (_key: string, value: unknown) =>
    typeof value === "bigint" ? value.toString() : value
  );
  application.use(express.json());
  application.use("/api/auth", authRouter);
  application.use("/api/users", usersRouter);
  application.use("/api/rbac", rbacRouter);
  application.use("/api/clients", clientsRouter);
  return application;
}

beforeEach(async () => {
  resetInMemoryDb();
  server = createServer(app());
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.equal(typeof address, "object");
  baseUrl = `http://127.0.0.1:${address!.port}`;
});

afterEach(async () => {
  if (!server) return;
  await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()));
  server = null;
  baseUrl = "";
});

async function api(
  method: string,
  path: string,
  options: { token?: string; body?: unknown; headers?: Record<string, string> } = {},
) {
  const headers: Record<string, string> = { ...(options.headers ?? {}) };
  if (options.body !== undefined) headers["content-type"] = "application/json";
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) : null;
  return { status: response.status, body };
}

async function login(email: string, password: string) {
  const response = await api("POST", "/api/auth/login", { body: { email, password } });
  assert.equal(response.status, 200, `connexion échouée pour ${email}: ${JSON.stringify(response.body)}`);
  return response.body as { accessToken: string; user: { role: string; permissions: string[] } };
}

describe("création administrateur et isolement des rôles", () => {
  it("prouve le flux SUPER_ADMIN → ADMIN avec mot de passe choisi et droits exacts", async () => {
    const superSession = await login("super.admin-roles@sxb.local", PASSWORDS.super);
    const motDePasseChoisi = "AdminChoisi!2026";

    const creation = await api("POST", "/api/users", {
      token: superSession.accessToken,
      body: {
        name: "Nouvel administrateur",
        email: "nouvel.admin@sxb.local",
        password: motDePasseChoisi,
        roleId: roleId("ADMIN"),
        status: "active",
      },
    });

    assert.equal(creation.status, 201);
    assert.equal(creation.body.email, "nouvel.admin@sxb.local");
    assert.equal(creation.body.role.name, "ADMIN");
    assert.equal("generatedPassword" in creation.body, false);

    const adminSession = await login("nouvel.admin@sxb.local", motDePasseChoisi);
    assert.equal(adminSession.user.role, "ADMIN");
    assert.deepEqual([...adminSession.user.permissions].sort(), permissionsDuRole("ADMIN"));

    const roles = await api("GET", "/api/rbac/roles", { token: adminSession.accessToken });
    assert.equal(roles.status, 200);
    assert.equal(roles.body.some((role: any) => role.name === "OWNER"), false);
    const adminRole = roles.body.find((role: any) => role.name === "ADMIN");
    assert.deepEqual([...adminRole.permissions].sort(), permissionsDuRole("ADMIN"));
  });

  it("applique les plafonds SUPER_ADMIN, ADMIN, SUPPORT, RESELLER et CLIENT", async () => {
    const superSession = await login("super.admin-roles@sxb.local", PASSWORDS.super);
    const adminSession = await login("admin.admin-roles@sxb.local", PASSWORDS.admin);
    const supportSession = await login("support.admin-roles@sxb.local", PASSWORDS.support);
    const resellerSession = await login("reseller.admin-roles@sxb.local", PASSWORDS.reseller);
    const clientSession = await login("client.admin-roles@sxb.local", PASSWORDS.client);

    const superCreateSupport = await api("POST", "/api/users", {
      token: superSession.accessToken,
      body: {
        name: "Support créé",
        email: "support.cree@sxb.local",
        password: "SupportCree!1",
        roleId: roleId("SUPPORT"),
        status: "active",
      },
    });
    assert.equal(superCreateSupport.status, 201);

    const superCreateOwner = await api("POST", "/api/users", {
      token: superSession.accessToken,
      body: {
        name: "Owner interdit",
        email: "owner.interdit@sxb.local",
        password: "OwnerInterdit!1",
        roleId: roleId("OWNER"),
        status: "active",
      },
    });
    assert.equal(superCreateOwner.status, 403);

    const adminCreateSuper = await api("POST", "/api/users", {
      token: adminSession.accessToken,
      body: {
        name: "Super interdit",
        email: "super.interdit@sxb.local",
        password: "SuperInterdit!1",
        roleId: roleId("SUPER_ADMIN"),
        status: "active",
      },
    });
    assert.equal(adminCreateSuper.status, 403);

    const adminCreateOwner = await api("POST", "/api/users", {
      token: adminSession.accessToken,
      body: {
        name: "Owner interdit admin",
        email: "owner.admin.interdit@sxb.local",
        password: "OwnerAdminInterdit!1",
        roleId: roleId("OWNER"),
        status: "active",
      },
    });
    assert.equal(adminCreateOwner.status, 403);

    const adminModifySuper = await api("PATCH", `/api/users/${IDS.users.super}`, {
      token: adminSession.accessToken,
      body: { name: "Super modifié" },
    });
    assert.equal(adminModifySuper.status, 403);

    const adminModifyOwner = await api("PATCH", `/api/users/${IDS.users.owner}`, {
      token: adminSession.accessToken,
      body: { name: "Owner modifié" },
    });
    assert.equal(adminModifyOwner.status, 403);

    const supportWrite = await api("PATCH", `/api/users/${IDS.users.client}`, {
      token: supportSession.accessToken,
      body: { name: "Client modifié" },
    });
    assert.equal(supportWrite.status, 403);

    const resellerUsers = await api("GET", "/api/users", { token: resellerSession.accessToken });
    assert.equal(resellerUsers.status, 403);

    const resellerClients = await api("GET", "/api/clients", { token: resellerSession.accessToken });
    assert.equal(resellerClients.status, 200);
    assert.deepEqual(
      resellerClients.body.map((client: any) => client.id).sort(),
      ["client-own-explicit", "client-own-historical"],
    );

    const clientUsers = await api("GET", "/api/users", {
      token: clientSession.accessToken,
      headers: { "x-sxb-device-id": "device-client" },
    });
    assert.equal(clientUsers.status, 403);
  });

  it("verrouille la matrice RBAC contre l'escalade et le verrouillage", async () => {
    const superSession = await login("super.admin-roles@sxb.local", PASSWORDS.super);
    const adminSession = await login("admin.admin-roles@sxb.local", PASSWORDS.admin);

    const adminPatchRole = await api("PATCH", `/api/rbac/roles/${roleId("ADMIN")}`, {
      token: adminSession.accessToken,
      body: { permissions: ["users.view"] },
    });
    assert.equal(adminPatchRole.status, 403);

    const ownerPatch = await api("PATCH", `/api/rbac/roles/${roleId("OWNER")}`, {
      token: superSession.accessToken,
      body: { permissions: ["users.view"] },
    });
    assert.equal(ownerPatch.status, 403);
    assert.equal(ownerPatch.body.code, "RBAC_OWNER_LOCKED");

    const superLockout = await api("PATCH", `/api/rbac/roles/${roleId("SUPER_ADMIN")}`, {
      token: superSession.accessToken,
      body: { permissions: ["users.view"] },
    });
    assert.equal(superLockout.status, 409);
    assert.equal(superLockout.body.code, "RBAC_LOCKOUT_PREVENTED");
  });
});
