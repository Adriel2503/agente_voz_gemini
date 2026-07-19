const { Router } = require("express");
const { apiVozTokenAuth } = require("../middlewares/apiVozToken.middleware.js");
const ctrl = require("../controllers/sesiones.controller.js");

const router = Router();

// Todas requieren token aiyou_live_ (Bearer). Ver seccion 5 del HTML.
router.post("/sesiones", apiVozTokenAuth, ctrl.crearSesion);
router.get("/sesiones/:id", apiVozTokenAuth, ctrl.estadoSesion);
router.post("/sesiones/:id/terminar", apiVozTokenAuth, ctrl.terminarSesion);
router.get("/sesiones/:id/transcripcion", apiVozTokenAuth, ctrl.transcripcionSesion);

module.exports = router;
