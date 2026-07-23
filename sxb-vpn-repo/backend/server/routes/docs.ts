import { Router, Response, Request } from "express";

const router = Router();

const openApiSpec = {
  openapi: "3.0.0",
  info: {
    title: "SXB VPN SaaS Backend API",
    description: "API de gestion de plateforme SaaS VPN SXB. Gère les utilisateurs, les clients VPN, les revendeurs, les serveurs, l'intégration XPanel, les bons de réduction (vouchers), l'audit de sécurité, le RBAC et les métriques de trafic.",
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
          xpanelUserId: { type: "string" }
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
          210: { description: "Client créé et provisionné dans XPanel" }
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
    "/xpanel/sync": {
      post: {
        summary: "Synchroniser manuellement le serveur VPN",
        responses: {
          200: { description: "Synchronisation effectuée" }
        }
      }
    }
  }
};

// GET /api/docs/json
router.get("/json", (req: Request, res: Response) => {
  res.json(openApiSpec);
});

// GET /api/docs (Interactive Swagger UI page)
router.get("/", (req: Request, res: Response) => {
  const html = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>SXB VPN - API Documentation Swagger</title>
      <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5.9.0/swagger-ui.css" />
      <link rel="icon" type="image/png" href="https://unpkg.com/swagger-ui-dist@5.9.0/favicon-32x32.png" sizes="32x32" />
      <style>
        html { box-sizing: border-box; overflow: -moz-scrollbars-vertical; overflow-y: scroll; }
        *, *:before, *:after { box-sizing: inherit; }
        body { margin: 0; background: #0f172a; font-family: 'Inter', sans-serif; color: #f8fafc; }
        .swagger-ui { filter: invert(0.9) hue-rotate(180deg); }
        .swagger-ui .topbar { display: none; }
        header { background: #020617; padding: 20px; border-b: 1px solid #1e293b; text-align: center; }
        h1 { margin: 0; color: #06b6d4; font-size: 24px; letter-spacing: 2px; }
        p { margin: 5px 0 0; color: #94a3b8; font-size: 14px; }
      </style>
    </head>
    <body>
      <header>
        <h1>SXB VPN PRO GATEWAY</h1>
        <p>Documentation API Interactive OpenAPI 3.0.0</p>
      </header>
      <div id="swagger-ui"></div>
      <script src="https://unpkg.com/swagger-ui-dist@5.9.0/swagger-ui-bundle.js" charset="UTF-8"></script>
      <script src="https://unpkg.com/swagger-ui-dist@5.9.0/swagger-ui-standalone-preset.js" charset="UTF-8"></script>
      <script>
        window.onload = () => {
          window.ui = SwaggerUIBundle({
            url: '/api/docs/json',
            dom_id: '#swagger-ui',
            deepLinking: true,
            presets: [
              SwaggerUIBundle.presets.apis,
              SwaggerUIStandalonePreset
            ],
            layout: "BaseLayout"
          });
        };
      </script>
    </body>
    </html>
  `;
  res.send(html);
});

export default router;
