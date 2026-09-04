import express from "express";
import { handleGenerateCoupon, handleListCoupons, handleGetReport } from "../controllers/admin.js";

// Every route under /api/admin is an administrative operation. Authentication is
// out of scope for this exercise, so they are namespaced rather than protected.
const adminRouter = express.Router();

adminRouter.post("/coupons", handleGenerateCoupon);
adminRouter.get("/coupons", handleListCoupons);
adminRouter.get("/report", handleGetReport);

export default adminRouter;
