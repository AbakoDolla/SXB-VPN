import { Router, Response, Request } from "express";

const router = Router();

const openApiSpec = {
  openapi: "3.0.0",
  info: {
    title: "SXB VPN SaaS Backend API",
    description: "API de gestion de plateforme SaaS VPN SXB. Gère les utilisateurs, les clients VPN, les revendeurs, les serveurs, les bons de réduction (vouchers), l'audit de sécurité, le RBAC et les métriques de trafic.",
    version: "1.0.0",
    contact: {
      name: "SXB Enterprise Support",
      email: "support@sxb-vpn.com"
    }
  },
  servers: [
    {
      url: "/api",
      description: "SXB VPN Gateway Router Server"
    }
  ],
  components: {
    securitySchemes: {
      BearerAuth: {
        type: "http",
        scheme: "bearer",
        bearerFormat: "JWT"
      }
    },
    schemas: {
      User: {
        type: "object",
        properties: {
          id: { type: "string" },
          name: { type: "string" },
          email: { type: "string" },
          phone: { type: "string" },
          roleId: { type: "string" },
          status: { type: "string", enum: ["active", "suspended"] },
          createdAt: { type: "string", format: "date-time" }
        }
      },
      VpnClient: {
        type: "object",
        properties: {
          id: { type: "string" },
          userId: { type: "string" },
          token: { type: "string" },
          quotaTotal: { type: "string" },
          quotaUsed: { type: "string" },
          expireAt: { type: "string", format: "date-time" },
          status: { type: "string", enum: ["active", "suspended", "expired"] },
        }
      },
      Reseller: {
        type: "object",
        properties: {
          id: { type: "string" },
          userId: { type: "string" },
          commission: { type: "number" },
          status: { type: "string" }
        }
      },
      TokenSXB: {
        type: "object",
        properties: {
          id: { type: "string" },
          token: { type: "string" },
          clientId: { type: "string" },
          quota: { type: "string" },
          expiration: { type: "string" },
          deviceLimit: { type: "integer" },
          status: { type: "string" }
        }
      },
      Voucher: {
        type: "object",
        properties: {
          id: { type: "string" },
          code: { type: "string" },
          quota: { type: "string" },
          durationDays: { type: "integer" },
          isRedeemed: { type: "boolean" }
        }
      }
    }
  },
  security: [
    {
      BearerAuth: []
    }
  ],
  paths: {
    "/auth/login": {
      post: {
        summary: "Connexion utilisateur",
        description: "Permet de s'authentifier et de recevoir les clés JWT (Access + Refresh Token)",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["email", "password"],
                properties: {
                  email: { type: "string", example: "admin@sxb-vpn.com" },
                  password: { type: "string", example: "admin123" }
                }
              }
            }
          }
        },
        responses: {
          200: {
            description: "Authentification réussie",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    accessToken: { type: "string" },
                    refreshToken: { type: "string" },
                    user: { $ref: "#/components/schemas/User" }
                  }
                }
              }
            }
          }
        }
      }
    },
    "/auth/refresh": {
      post: {
        summary: "Renouveler le jeton d'accès",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["refreshToken"],
                properties: {
                  refreshToken: { type: "string" }
                }
              }
            }
          }
        },
        responses: {
          200: {
            description: "Jeton renouvelé",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    accessToken: { type: "string" },
                    refreshToken: { type: "string" }
                  }
                }
              }
            }
          }
        }
      }
    },
    "/clients": {
      get: {
        summary: "Lister les clients VPN",
        responses: {
          200: {
            description: "Liste de clients",
            content: {
              "application/json": {
                schema: { type: "array", items: { $ref: "#/components/schemas/VpnClient" } }
              }
            }
          }
        }
      },
      post: {
        summary: "Créer un client VPN",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["userId", "name"],
                properties: {
                  userId: { type: "string" },
                  name: { type: "string" },
                  quotaTotalGb: { type: "number", default: 100 },
                  durationDays: { type: "number", default: 30 },
                  deviceLimit: { type: "number", default: 1 }
                }
              }
            }
          }
        },
        responses: {
        }
      }
    },
    "/tokens/generate": {
      post: {
        summary: "Générer un jeton d'activation SXB",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["clientId"],
                properties: {
                  clientId: { type: "string" },
                  quotaGb: { type: "number", default: 50 },
                  durationDays: { type: "number", default: 30 }
                }
              }
            }
          }
        },
        responses: {
          201: { description: "Token généré" }
        }
      }
    },
    "/vouchers/redeem": {
      post: {
        summary: "Utiliser un code coupon",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["code", "clientId"],
                properties: {
                  code: { type: "string", example: "SXB-VOUCH-50G-FREE" },
                  clientId: { type: "string" }
                }
              }
            }
          }
        },
        responses: {
          200: { description: "Coupon appliqué" }
        }
      }
    },
