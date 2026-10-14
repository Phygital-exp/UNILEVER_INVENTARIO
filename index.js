const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");
const app = express();

// ========== CONFIGURACIÓN (variables de entorno en Railway) ==========
const PORT = process.env.PORT || 8080;
const API_TOKEN = process.env.API_TOKEN;
const API_BASE_URL = (process.env.API_BASE_URL ||
    "https://botai.smartdataautomation.com/api_backend_ai/dinamic-db/report/119").replace(/\/+$/, "");
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "https://phygital-exp.github.io")
    .split(",").map(o => o.trim().replace(/\/+$/, "")).filter(Boolean);

if (!API_TOKEN) {
    console.error("❌ Falta la variable de entorno API_TOKEN. Configúrala en Railway.");
    process.exit(1);
}

const AUTH_HEADERS = {
    Authorization: `Token ${API_TOKEN}`,
    "Content-Type": "application/json",
};

const COLECCIONES = {
    usuarios: `${API_BASE_URL}/usuarios_unilevel`,
    ingresosPdv: `${API_BASE_URL}/pdv_registro_unilevel`,
    productos: `${API_BASE_URL}/productos_unilevel`,
    registros: `${API_BASE_URL}/registro_inventario_unilevel`,
};

const ZONA_HORARIA = "America/Bogota";
const CANTIDAD_MAXIMA = 999999;

// Estados del ingreso al punto (pdv_registro_unilevel), los mismos que usa el chatbot
const PDV_EN_PUNTO = "EN PUNTO";
const PDV_FUERA_DE_PUNTO = "FUERA DE PUNTO";

// Estados de cada producto en registro_inventario_unilevel
const PRODUCTO_PENDIENTE = "PENDIENTE";
const PRODUCTO_FINALIZADO = "FINALIZADO";

// Estados de marca en la respuesta al front
const MARCA_EN_PROCESO = "EN_PROCESO";
const MARCA_FINALIZADA = "FINALIZADA";

// Cuántos POST simultáneos se envían al finalizar una marca
const ENVIOS_SIMULTANEOS = 5;

// ========== CORS: solo GitHub Pages (y los orígenes configurados) ==========
app.use(cors({
    origin(origin, callback) {
        // Peticiones sin origen (curl, health checks de Railway) se permiten
        if (!origin || ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
        callback(new Error(`Origen no permitido por CORS: ${origin}`));
    },
}));
app.use(express.json({ limit: "100kb" }));

// ========== UTILIDADES ==========
class ErrorApi extends Error {
    constructor(status, mensaje, extra = {}) {
        super(mensaje);
        this.status = status;
        this.extra = extra;
    }
}

// Envuelve los handlers async para que los errores lleguen al manejador central
const manejar = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const ahora = () => new Date().toISOString();

// Limpia espacios dobles y finales ("REXONA " -> "REXONA", "3D  LIQ" -> "3D LIQ")
const normalizarMarca = marca => String(marca || "").trim().replace(/\s+/g, " ").toUpperCase();
const normalizarEstado = estado => String(estado || "").trim().replace(/\s+/g, " ").toUpperCase();

const soloDigitos = valor => /^\d+$/.test(String(valor || "").trim());
const mismoValor = (a, b) => a !== undefined && a !== null && String(a).trim() === String(b).trim();

// GET a una colección; la API permite filtrar por igualdad con query params (?CAMPO=valor)
async function consultarColeccion(url, filtros = {}) {
    const query = new URLSearchParams(filtros).toString();
    const destino = query ? `${url}?${query}` : url;
    const response = await fetch(destino, { headers: AUTH_HEADERS });
    if (!response.ok) {
        const errorBody = await response.text();
        console.error(`❌ ${destino} respondió ${response.status}:`, errorBody);
        throw new ErrorApi(502, "No pudimos consultar la información. Intenta de nuevo.");
    }
    const data = await response.json();
    return Array.isArray(data.result) ? data.result : [];
}

// La API dinamic-db usa POST para todo:
//  - sin _id  -> crea el documento y responde { status: "ok", insert_id: "..." }
//  - con _id  -> actualiza ese documento; los campos deben llamarse EXACTAMENTE igual
//                que en la base, si no se crea un registro nuevo
async function enviarDocumento(url, doc) {
    const response = await fetch(url, {
        method: "POST",
        headers: AUTH_HEADERS,
        body: JSON.stringify(doc),
    });
    if (!response.ok) {
        const errorBody = await response.text();
        console.error(`❌ POST ${url} respondió ${response.status}:`, errorBody);
        throw new ErrorApi(502, "No pudimos guardar la información. Intenta de nuevo.");
    }
    return response.json().catch(() => ({}));
}

async function crearDocumento(url, doc) {
    const { _id, ...sinId } = doc;
    const data = await enviarDocumento(url, sinId);
    return data && data.insert_id ? String(data.insert_id) : null;
}

async function actualizarDocumento(url, id, campos) {
    const data = await enviarDocumento(url, { _id: String(id), ...campos });
    if (data && data.insert_id && String(data.insert_id) !== String(id)) {
        console.warn(`⚠️ Se esperaba actualizar ${id} pero la API creó ${data.insert_id}. Revisa los nombres de campos.`);
    }
}

// Fecha sin hora ("2026-10-14T00:00:00") y hora aparte ("15:46:32"), en hora de Colombia
function fechaYHoraLocal() {
    const d = new Date();
    const dia = new Intl.DateTimeFormat("en-CA", { timeZone: ZONA_HORARIA }).format(d);
    const hora = new Intl.DateTimeFormat("en-GB", {
        timeZone: ZONA_HORARIA, hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
    }).format(d);
    return { FECHA_REGISTRO: `${dia}T00:00:00`, HORA_REGISTRO: hora };
}

// Serializa las operaciones sobre una misma visita para no pisar cambios simultáneos
const bloqueos = new Map();
function conBloqueo(clave, fn) {
    const anterior = bloqueos.get(clave) || Promise.resolve();
    const actual = anterior.catch(() => {}).then(fn);
    const cola = actual.catch(() => {});
    bloqueos.set(clave, cola);
    cola.then(() => { if (bloqueos.get(clave) === cola) bloqueos.delete(clave); });
    return actual;
}

async function enParalelo(items, limite, fn) {
    let siguiente = 0;
    const trabajadores = Array.from({ length: Math.min(limite, items.length) }, async () => {
        while (siguiente < items.length) await fn(items[siguiente++]);
    });
    await Promise.all(trabajadores);
}

// ========== PRODUCTOS (con caché corta: el catálogo cambia poco) ==========
const CACHE_PRODUCTOS_MS = 5 * 60 * 1000;
let cacheProductos = { datos: null, expira: 0 };

async function obtenerProductos() {
    if (cacheProductos.datos && Date.now() < cacheProductos.expira) return cacheProductos.datos;

    const crudos = await consultarColeccion(COLECCIONES.productos);
    const datos = crudos
        .filter(p => p._id && p.MARCA)
        .map(p => ({
            PRODUCTO_ID: String(p._id),
            MARCA: normalizarMarca(p.MARCA),
            DESC: String(p.DESC || "").trim(),
            EAN: p["EAN 13"] !== undefined && p["EAN 13"] !== null ? String(p["EAN 13"]) : "",
        }))
        .sort((a, b) => a.DESC.localeCompare(b.DESC, "es"));

    cacheProductos = { datos, expira: Date.now() + CACHE_PRODUCTOS_MS };
    return datos;
}

async function productosDeMarca(marca) {
    const objetivo = normalizarMarca(marca);
    return (await obtenerProductos()).filter(p => p.MARCA === objetivo);
}

// ========== USUARIOS E INGRESOS AL PUNTO ==========
async function buscarUsuario(cedula) {
    const usuarios = await consultarColeccion(COLECCIONES.usuarios, { CEDULA: cedula });
    return usuarios.find(u => mismoValor(u.CEDULA, cedula)) || null;
}

// El chatbot registra en pdv_registro_unilevel el punto que la persona visita.
// Se toma el ingreso MÁS RECIENTE de esa cédula.
async function buscarUltimoIngreso(cedula) {
    const ingresos = await consultarColeccion(COLECCIONES.ingresosPdv, { CEDULA: cedula });
    return ingresos
        .filter(i => mismoValor(i.CEDULA, cedula))
        .sort((a, b) => String(b.created).localeCompare(String(a.created)))[0] || null;
}

async function obtenerIngresoOError(id) {
    const ingresos = await consultarColeccion(COLECCIONES.ingresosPdv, { _id: id });
    const ingreso = ingresos.find(i => String(i._id) === String(id));
    if (!ingreso) throw new ErrorApi(404, "No encontramos tu visita al punto de venta. Vuelve a ingresar tu cédula.");
    return ingreso;
}

const estaEnPunto = ingreso => normalizarEstado(ingreso.ESTADO) === PDV_EN_PUNTO;

function exigirEnPunto(ingreso) {
    if (!estaEnPunto(ingreso)) {
        throw new ErrorApi(409, "El inventario de este punto ya fue cerrado y no se puede modificar.");
    }
}

// ID_REGISTRO del ingreso: es el que une cada producto inventariado con la visita
function idRegistroDe(ingreso) {
    if (ingreso.ID_REGISTRO === undefined || ingreso.ID_REGISTRO === null || ingreso.ID_REGISTRO === "") {
        console.error(`❌ El ingreso ${ingreso._id} no tiene ID_REGISTRO`);
        throw new ErrorApi(409, "Tu visita no tiene un código de registro. Comunícate con tu coordinador.");
    }
    return ingreso.ID_REGISTRO;
}

// ========== INVENTARIO (un documento por producto) ==========
// registro_inventario_unilevel: { EAN, DESC, CANTIDAD, FECHA_REGISTRO, HORA_REGISTRO, ID_REGISTRO, ESTADO }
async function documentosDeVisita(idRegistro) {
    const docs = await consultarColeccion(COLECCIONES.registros, { ID_REGISTRO: idRegistro });
    return docs.filter(d => mismoValor(d.ID_REGISTRO, idRegistro) && d.EAN !== undefined && d.EAN !== null);
}

// EAN -> documento más reciente (por si quedara algún duplicado)
function documentosPorEan(docs) {
    const mapa = new Map();
    for (const d of docs) {
        const ean = String(d.EAN).trim();
        const previo = mapa.get(ean);
        if (!previo || String(d.created || "") > String(previo.created || "")) mapa.set(ean, d);
    }
    return mapa;
}

const tieneCantidad = doc => doc && Number.isInteger(Number(doc.CANTIDAD)) && Number(doc.CANTIDAD) >= 0
    && doc.CANTIDAD !== null && doc.CANTIDAD !== "";
const estaFinalizado = doc => doc && normalizarEstado(doc.ESTADO) === PRODUCTO_FINALIZADO;

const marcaCompleta = (productos, porEan) => productos.length > 0 && productos.every(p => estaFinalizado(porEan.get(p.EAN)));
const marcaBloqueada = (productos, porEan) => productos.some(p => estaFinalizado(porEan.get(p.EAN)));

// Respuesta al front: misma forma de siempre (USUARIO, PUNTO_VENTA, MARCAS[...])
async function construirVista(ingreso, docs) {
    const catalogo = await obtenerProductos();
    const porEan = documentosPorEan(docs);

    const porMarca = new Map();
    for (const p of catalogo) {
        if (!porMarca.has(p.MARCA)) porMarca.set(p.MARCA, []);
        porMarca.get(p.MARCA).push(p);
    }

    const MARCAS = [];
    for (const [MARCA, productos] of porMarca) {
        const PRODUCTOS = productos
            .filter(p => tieneCantidad(porEan.get(p.EAN)))
            .map(p => ({
                PRODUCTO_ID: p.PRODUCTO_ID,
                EAN: p.EAN,
                DESC: p.DESC,
                MARCA,
                CANTIDAD: Number(porEan.get(p.EAN).CANTIDAD),
            }));
        if (PRODUCTOS.length === 0 && !marcaBloqueada(productos, porEan)) continue;
        MARCAS.push({
            MARCA,
            ESTADO: marcaCompleta(productos, porEan) ? MARCA_FINALIZADA : MARCA_EN_PROCESO,
            PRODUCTOS,
        });
    }

    const todasFinalizadas = [...porMarca.values()].every(productos => marcaCompleta(productos, porEan));

    return {
        _id: String(ingreso._id),
        ID_REGISTRO: ingreso.ID_REGISTRO,
        USUARIO: { CEDULA: String(ingreso.CEDULA ?? ""), NOMBRE: ingreso.NOMBRE ?? null },
        PUNTO_VENTA: {
            CODIGO: ingreso.SAP !== undefined && ingreso.SAP !== null ? String(ingreso.SAP) : null,
            NOMBRE: ingreso.PDV ?? null,
            CIUDAD: ingreso.CIUDAD ?? null,
            ESTADO: ingreso.ESTADO ?? null,
        },
        MARCAS,
        INVENTARIO_FINALIZADO: todasFinalizadas || !estaEnPunto(ingreso),
    };
}

// ========== ENDPOINTS ==========

// Paso 1: validar cédula
app.get("/api/usuarios/:cedula", manejar(async (req, res) => {
    const cedula = String(req.params.cedula || "").trim();
    if (!soloDigitos(cedula)) {
        throw new ErrorApi(400, "La cédula solo debe tener números.");
    }

    console.log(`🔎 Validando cédula: ${cedula}`);
    const usuario = await buscarUsuario(cedula);

    if (!usuario) {
        return res.json({ existe: false, mensaje: "No encontramos tu cédula, verifícala e intenta de nuevo" });
    }
    res.json({ existe: true, usuario });
}));

// Paso 1 (confirmado "Sí, soy yo"): ubica la visita activa ("EN PUNTO") y devuelve su progreso
app.post("/api/registros", manejar(async (req, res) => {
    const cedula = String((req.body && req.body.cedula) || "").trim();
    if (!soloDigitos(cedula)) {
        throw new ErrorApi(400, "La cédula solo debe tener números.");
    }

    const usuario = await buscarUsuario(cedula);
    if (!usuario) throw new ErrorApi(404, "No encontramos tu cédula, verifícala e intenta de nuevo");

    const ingreso = await buscarUltimoIngreso(cedula);
    if (!ingreso) {
        throw new ErrorApi(404,
            "No encontramos tu ingreso a un punto de venta. Primero indica en el chatbot a qué punto vas.");
    }
    if (!estaEnPunto(ingreso)) {
        throw new ErrorApi(409,
            "Tu último punto de venta ya está cerrado. Registra en el chatbot el nuevo punto que vas a visitar.");
    }

    const docs = await documentosDeVisita(idRegistroDe(ingreso));
    console.log(`📍 ${cedula} en punto ${ingreso.PDV} (ID_REGISTRO ${ingreso.ID_REGISTRO}) · ${docs.length} productos guardados`);
    res.json({ registro: await construirVista(ingreso, docs) });
}));

// Recuperar progreso (id = _id del ingreso en pdv_registro_unilevel)
app.get("/api/registros/:id", manejar(async (req, res) => {
    const ingreso = await obtenerIngresoOError(req.params.id);
    const docs = await documentosDeVisita(idRegistroDe(ingreso));
    res.json({ registro: await construirVista(ingreso, docs) });
}));

// Paso 2: marcas únicas en orden alfabético
app.get("/api/marcas", manejar(async (req, res) => {
    const conteo = new Map();
    for (const p of await obtenerProductos()) {
        conteo.set(p.MARCA, (conteo.get(p.MARCA) || 0) + 1);
    }
    const marcas = [...conteo.entries()]
        .map(([MARCA, TOTAL_PRODUCTOS]) => ({ MARCA, TOTAL_PRODUCTOS }))
        .sort((a, b) => a.MARCA.localeCompare(b.MARCA, "es"));
    res.json({ marcas });
}));

// Paso 3: productos de una marca
app.get("/api/productos", manejar(async (req, res) => {
    const marca = normalizarMarca(req.query.marca);
    if (!marca) throw new ErrorApi(400, "Debes indicar la marca.");
    res.json({ marca, productos: await productosDeMarca(marca) });
}));

// Paso 3: guardar o editar la cantidad de un producto
app.put("/api/registros/:id/producto", manejar(async (req, res) => {
    const id = req.params.id;
    const { productoId, cantidad } = req.body || {};

    const textoCantidad = String(cantidad ?? "").trim();
    if (!/^\d+$/.test(textoCantidad) || Number(textoCantidad) > CANTIDAD_MAXIMA) {
        throw new ErrorApi(400, "La cantidad debe ser un número entero igual o mayor a 0.");
    }
    const valor = Number(textoCantidad);

    const producto = (await obtenerProductos()).find(p => p.PRODUCTO_ID === String(productoId));
    if (!producto) throw new ErrorApi(404, "Este producto no existe en el catálogo.");

    const registro = await conBloqueo(`visita:${id}`, async () => {
        const ingreso = await obtenerIngresoOError(id);
        exigirEnPunto(ingreso);
        const idRegistro = idRegistroDe(ingreso);

        let docs = await documentosDeVisita(idRegistro);
        const porEan = documentosPorEan(docs);

        if (marcaBloqueada(await productosDeMarca(producto.MARCA), porEan)) {
            throw new ErrorApi(409, `La marca ${producto.MARCA} ya fue finalizada y no se puede editar.`);
        }

        const fechaHora = fechaYHoraLocal();
        const existente = porEan.get(producto.EAN);

        if (existente) {
            const cambios = { CANTIDAD: valor, ...fechaHora };
            await actualizarDocumento(COLECCIONES.registros, existente._id, cambios);
            docs = docs.map(d => (d === existente ? { ...d, ...cambios } : d));
        } else {
            const nuevo = {
                EAN: producto.EAN,
                DESC: producto.DESC,
                CANTIDAD: valor,
                ...fechaHora,
                ID_REGISTRO: idRegistro,
                ESTADO: PRODUCTO_PENDIENTE,
            };
            const insertId = await crearDocumento(COLECCIONES.registros, nuevo);
            docs = insertId
                ? [...docs, { _id: insertId, created: ahora(), ...nuevo }]
                : await documentosDeVisita(idRegistro); // respaldo si no llega insert_id
        }

        return construirVista(ingreso, docs);
    });

    console.log(`💾 ${id} · ${producto.MARCA} · ${producto.EAN} = ${valor}`);
    res.json({ registro });
}));

// Valida las cantidades que el front envía al finalizar: [{ productoId, cantidad }] -> Map(EAN -> cantidad)
function cantidadesDeMarca(lista, catalogoMarca) {
    if (lista === undefined || lista === null) return new Map();
    if (!Array.isArray(lista)) throw new ErrorApi(400, "Los datos enviados no son válidos.");

    const porId = new Map(catalogoMarca.map(p => [p.PRODUCTO_ID, p]));
    const resultado = new Map();
    for (const item of lista) {
        const producto = porId.get(String(item && item.productoId));
        if (!producto) throw new ErrorApi(400, "Uno de los productos enviados no pertenece a esta marca.");
        const texto = String(item.cantidad ?? "").trim();
        if (!/^\d+$/.test(texto) || Number(texto) > CANTIDAD_MAXIMA) {
            throw new ErrorApi(400, `La cantidad de ${producto.DESC} debe ser un número entero igual o mayor a 0.`);
        }
        resultado.set(producto.EAN, Number(texto));
    }
    return resultado;
}

// Paso 3: finalizar marca. Recibe opcionalmente { cantidades: [{ productoId, cantidad }] } con los
// valores escritos que aún no se habían enviado: se guardan y se finaliza todo en un solo paso.
// Todos los productos quedan en FINALIZADO y el servidor rechaza cualquier cambio posterior.
// Si era la última marca, el ingreso pasa a "FUERA DE PUNTO".
app.post("/api/registros/:id/marcas/:marca/finalizar", manejar(async (req, res) => {
    const id = req.params.id;
    const nombreMarca = normalizarMarca(req.params.marca);

    const catalogoMarca = await productosDeMarca(nombreMarca);
    if (catalogoMarca.length === 0) throw new ErrorApi(404, "Esta marca no existe en el catálogo.");
    const nuevas = cantidadesDeMarca(req.body && req.body.cantidades, catalogoMarca);

    const resultado = await conBloqueo(`visita:${id}`, async () => {
        const ingreso = await obtenerIngresoOError(id);
        exigirEnPunto(ingreso);
        const idRegistro = idRegistroDe(ingreso);

        let docs = await documentosDeVisita(idRegistro);
        let porEan = documentosPorEan(docs);

        if (marcaCompleta(catalogoMarca, porEan)) {
            throw new ErrorApi(409, `La marca ${nombreMarca} ya estaba finalizada.`);
        }

        // Se revisan faltantes ANTES de escribir nada, para no dejar la marca a medias
        const faltantes = catalogoMarca.filter(p => !nuevas.has(p.EAN) && !tieneCantidad(porEan.get(p.EAN)));
        if (faltantes.length > 0) {
            throw new ErrorApi(409, `Te faltan ${faltantes.length} productos por registrar.`, { faltantes });
        }

        // Un solo POST por producto: guarda la cantidad (si llegó una nueva) y lo deja FINALIZADO
        const fechaHora = fechaYHoraLocal();
        const operaciones = [];
        for (const p of catalogoMarca) {
            const doc = porEan.get(p.EAN);
            if (estaFinalizado(doc)) continue; // ya quedó finalizado en un intento anterior
            const cantidad = nuevas.get(p.EAN);
            if (!doc) {
                operaciones.push(() => crearDocumento(COLECCIONES.registros, {
                    EAN: p.EAN,
                    DESC: p.DESC,
                    CANTIDAD: cantidad,
                    ...fechaHora,
                    ID_REGISTRO: idRegistro,
                    ESTADO: PRODUCTO_FINALIZADO,
                }));
            } else if (cantidad !== undefined && cantidad !== Number(doc.CANTIDAD)) {
                operaciones.push(() => actualizarDocumento(COLECCIONES.registros, doc._id, {
                    CANTIDAD: cantidad, ...fechaHora, ESTADO: PRODUCTO_FINALIZADO,
                }));
            } else {
                operaciones.push(() => actualizarDocumento(COLECCIONES.registros, doc._id, { ESTADO: PRODUCTO_FINALIZADO }));
            }
        }

        // Posibles documentos duplicados del mismo EAN también se finalizan
        const principales = new Set([...porEan.values()].map(d => d._id));
        const eanMarca = new Set(catalogoMarca.map(p => p.EAN));
        for (const d of docs) {
            if (!principales.has(d._id) && eanMarca.has(String(d.EAN).trim()) && !estaFinalizado(d)) {
                operaciones.push(() => actualizarDocumento(COLECCIONES.registros, d._id, { ESTADO: PRODUCTO_FINALIZADO }));
            }
        }

        await enParalelo(operaciones, ENVIOS_SIMULTANEOS, op => op());
        console.log(`✅ ${id} · marca ${nombreMarca} finalizada (${operaciones.length} envíos, ${nuevas.size} cantidades nuevas)`);

        // Se relee la visita para responder con lo que quedó realmente en la base
        docs = await documentosDeVisita(idRegistro);
        porEan = documentosPorEan(docs);

        // ¿Era la última marca? -> se cierra el ingreso al punto
        const catalogo = await obtenerProductos();
        const inventarioFinalizado = catalogo.every(p => estaFinalizado(porEan.get(p.EAN)));
        if (inventarioFinalizado) {
            await actualizarDocumento(COLECCIONES.ingresosPdv, ingreso._id, { ESTADO: PDV_FUERA_DE_PUNTO });
            ingreso.ESTADO = PDV_FUERA_DE_PUNTO;
            console.log(`🏁 ${id} · inventario completo, ingreso pasa a "${PDV_FUERA_DE_PUNTO}"`);
        }

        return { registro: await construirVista(ingreso, docs), inventarioFinalizado };
    });

    res.json(resultado);
}));

// ========== HEALTH CHECK ==========
app.get("/health", (req, res) => {
    res.json({ status: "OK", timestamp: ahora() });
});

// ========== 404 Y ERRORES ==========
app.use((req, res) => {
    res.status(404).json({ error: "Ruta no encontrada" });
});

app.use((err, req, res, next) => {
    if (err instanceof ErrorApi) {
        return res.status(err.status).json({ error: err.message, ...err.extra });
    }
    if (err.type === "entity.parse.failed") {
        return res.status(400).json({ error: "Los datos enviados no son válidos." });
    }
    if (err.message && err.message.startsWith("Origen no permitido")) {
        return res.status(403).json({ error: err.message });
    }
    console.error("❌ Error inesperado:", err);
    res.status(500).json({ error: "Ocurrió un error inesperado. Intenta de nuevo." });
});

app.listen(PORT, () => {
    console.log(`🚀 Proxy de inventario escuchando en puerto ${PORT}`);
    console.log(`🌐 CORS permitido para: ${ALLOWED_ORIGINS.join(", ")}`);
    console.log(`📍 Endpoints disponibles:`);
    console.log(`   - GET  /api/usuarios/:cedula`);
    console.log(`   - POST /api/registros`);
    console.log(`   - GET  /api/registros/:id`);
    console.log(`   - GET  /api/marcas`);
    console.log(`   - GET  /api/productos?marca=DOVE`);
    console.log(`   - PUT  /api/registros/:id/producto`);
    console.log(`   - POST /api/registros/:id/marcas/:marca/finalizar`);
    console.log(`   - GET  /health`);
});
