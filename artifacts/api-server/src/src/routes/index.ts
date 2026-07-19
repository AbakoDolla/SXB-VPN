import { Router, type IRouter } from "express";
import healthRouter from "./health.js";
import authRouter from "./auth.js";
import mobileRouter from "./mobile.js";

import dashboardRouter from "./dashboard.js";
import clientsRouter from "./clients.js";
import usersRouter from "./users.js";
import adminTokensRouter from "./admin-tokens.js";
import analyticsRouter from "./analytics.js";

const router: IRouter = Router();

// Health
router.use(healthRouter);

// Auth
router.use("/auth", authRouter);

// Mobile app API
router.use("/mobile", mobileRouter);


// Dashboard stats
router.use("/dashboard", dashboardRouter);

// VPN clients management
router.use("/clients", clientsRouter);

// Users management
router.use("/users", usersRouter);

// Admin tokens
router.use("/admin-tokens", adminTokensRouter);

// Analytics
router.use("/analytics", analyticsRouter);

export default router;
