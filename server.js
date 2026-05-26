const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = 3080;

// Configurações do FIWARE
const IOTA_URL = 'http://localhost:4041';
const IOTA_DATA_URL = 'http://localhost:7896';
const ORION_URL = 'http://localhost:1026';
const API_KEY = '1234';

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const fiwareHeaders = {
    'fiware-service': 'openiot',
    'fiware-servicepath': '/'
};

// Estados de controle em memória
const activeSimulations = {};
const coverCooldown = {};    // Armazena o timestamp de quando a tampa foi fechada
const drainingDevices = {};  // Controla se o bueiro está em processo de esvaziamento

function isValidCoordinates(lat, lng) {
    return lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;
}

// Inicialização Automatizada do FIWARE
async function initFiware() {
    try {
        console.log('🔄 Inicializando configurações no FIWARE...');
        
        await axios.post(`${IOTA_URL}/iot/services`, {
            services: [{
                apikey: API_KEY,
                cbroker: "http://orion:1026",
                entity_type: "Manhole",
                resource: "/iot/json"
            }]
        }, { headers: fiwareHeaders }).catch(err => {
            if (err.response && err.response.status === 409) {
                console.log('ℹ️ Service Group já configurado.');
            } else throw err;
        });

        await axios.post(`${ORION_URL}/v2/subscriptions`, {
            description: "Notify QuantumLeap",
            subject: {
                entities: [{ idPattern: ".*", type: "Manhole" }]
            },
            notification: {
                http: { url: "http://quantumleap:8668/v2/notify" },
                attrs: ["waterLevel", "coverStatus", "location", "lastMaintenance", "observationDate"]
            },
            throttling: 1
        }, { headers: fiwareHeaders }).catch(err => {
            console.log('ℹ️ Verificação de subscription concluída (ou já existente).');
        });

        console.log('✅ FIWARE totalmente integrado e pronto!');
    } catch (error) {
        console.error('❌ Erro na comunicação inicial com o FIWARE.', error.message);
    }
}

// Buscar todos os bueiros do Orion
app.get('/api/devices', async (req, res) => {
    try {
        const response = await axios.get(`${ORION_URL}/v2/entities?type=Manhole`, { headers: fiwareHeaders });
        
        const devices = response.data.map(entity => ({
            id: entity.id,
            deviceId: entity.id.split(':').pop(),
            waterLevel: entity.waterLevel ? entity.waterLevel.value : 0,
            coverStatus: entity.coverStatus ? entity.coverStatus.value : 'unknown',
            location: entity.location ? entity.location.value : null,
            lastMaintenance: entity.lastMaintenance ? entity.lastMaintenance.value : '',
            isSimulating: !!activeSimulations[entity.id],
            isDraining: !!drainingDevices[entity.id] // <--- NOVO: Informa ao frontend se já está drenando
        }));
        
        res.json(devices);
    } catch (error) {
        res.status(500).json({ error: 'Erro ao buscar dispositivos no Orion', details: error.message });
    }
});

// Cadastrar novo dispositivo
app.post('/api/devices', async (req, res) => {
    const { deviceId, latitude, longitude, lastMaintenance } = req.body;
    
    if (!deviceId || latitude === undefined || longitude === undefined) {
        return res.status(400).json({ error: 'Campos obrigatórios ausentes.' });
    }

    if (!isValidCoordinates(parseFloat(latitude), parseFloat(longitude))) {
        return res.status(400).json({ error: 'Latitude ou longitude inválidas.' });
    }

    try {
        const payload = {
            devices: [{
                device_id: deviceId,
                entity_name: `urn:ngsi-ld:Manhole:${deviceId}`,
                entity_type: "Manhole",
                protocol: "IoTA-JSON",
                transport: "HTTP",
                attributes: [
                    { object_id: "wl", name: "waterLevel", type: "Number" },
                    { object_id: "cs", name: "coverStatus", type: "Text" },
                    { object_id: "loc", name: "location", type: "geo:json" },
                    { object_id: "lm", name: "lastMaintenance", type: "DateTime" },
                    { object_id: "od", name: "observationDate", type: "DateTime" }
                ]
            }]
        };

        await axios.post(`${IOTA_URL}/iot/devices`, payload, { headers: fiwareHeaders });
        
        await axios.post(`${IOTA_DATA_URL}/iot/json?k=${API_KEY}&i=${deviceId}`, {
            wl: 0,
            cs: "closed",
            loc: { type: "Point", coordinates: [parseFloat(longitude), parseFloat(latitude)] },
            lm: new Date(lastMaintenance || Date.now()).toISOString(),
            od: new Date().toISOString()
        });

        res.status(201).json({ message: `Dispositivo ${deviceId} registrado com sucesso!` });
    } catch (error) {
        res.status(500).json({ error: 'Erro ao registrar dispositivo', details: error.message });
    }
});

// Editar Dispositivo / Salvar Alterações
app.put('/api/devices/:oldDeviceId', async (req, res) => {
    const { oldDeviceId } = req.params;
    const { deviceId, latitude, longitude, waterLevel, coverStatus, lastMaintenance } = req.body;

    if (!isValidCoordinates(parseFloat(latitude), parseFloat(longitude))) {
        return res.status(400).json({ error: 'Latitude ou longitude inválidas.' });
    }

    const oldEntityId = `urn:ngsi-ld:Manhole:${oldDeviceId}`;
    const newEntityId = `urn:ngsi-ld:Manhole:${deviceId}`;

    try {
        if (oldDeviceId !== deviceId) {
            await axios.delete(`${IOTA_URL}/iot/devices/${oldDeviceId}`, { headers: fiwareHeaders }).catch(() => {});
            await axios.delete(`${ORION_URL}/v2/entities/${oldEntityId}`, { headers: fiwareHeaders }).catch(() => {});

            const payload = {
                devices: [{
                    device_id: deviceId,
                    entity_name: newEntityId,
                    entity_type: "Manhole",
                    protocol: "IoTA-JSON",
                    transport: "HTTP",
                    attributes: [
                        { object_id: "wl", name: "waterLevel", type: "Number" },
                        { object_id: "cs", name: "coverStatus", type: "Text" },
                        { object_id: "loc", name: "location", type: "geo:json" },
                        { object_id: "lm", name: "lastMaintenance", type: "DateTime" },
                        { object_id: "od", name: "observationDate", type: "DateTime" }
                    ]
                }]
            };
            await axios.post(`${IOTA_URL}/iot/devices`, payload, { headers: fiwareHeaders });
            
            if (activeSimulations[oldEntityId]) {
                clearInterval(activeSimulations[oldEntityId]);
                delete activeSimulations[oldEntityId];
            }
            coverCooldown[newEntityId] = coverCooldown[oldEntityId];
            drainingDevices[newEntityId] = drainingDevices[oldEntityId];
        }

        if (coverStatus === 'closed') {
            coverCooldown[newEntityId] = Date.now();
        }

        await axios.post(`${IOTA_DATA_URL}/iot/json?k=${API_KEY}&i=${deviceId}`, {
            wl: parseInt(waterLevel),
            cs: coverStatus,
            loc: { type: "Point", coordinates: [parseFloat(longitude), parseFloat(latitude)] },
            lm: new Date(lastMaintenance || Date.now()).toISOString(),
            od: new Date().toISOString()
        });

        res.json({ message: 'Dispositivo atualizado com sucesso!' });
    } catch (error) {
        res.status(500).json({ error: 'Erro ao atualizar dispositivo.', details: error.message });
    }
});

// Forçar Fechamento de Tampa
app.post('/api/devices/:deviceId/close-cover', async (req, res) => {
    const { deviceId } = req.params;
    const entityId = `urn:ngsi-ld:Manhole:${deviceId}`;

    try {
        const orionRes = await axios.get(`${ORION_URL}/v2/entities/${entityId}`, { headers: fiwareHeaders });
        const entity = orionRes.data;

        coverCooldown[entityId] = Date.now();

        await axios.post(`${IOTA_DATA_URL}/iot/json?k=${API_KEY}&i=${deviceId}`, {
            wl: entity.waterLevel ? entity.waterLevel.value : 0,
            cs: 'closed',
            loc: entity.location.value,
            lm: entity.lastMaintenance.value,
            od: new Date().toISOString()
        });

        res.json({ message: 'Tampa fechada com sucesso.' });
    } catch (error) {
        res.status(500).json({ error: 'Erro ao fechar a tampa.', details: error.message });
    }
});

// Iniciar Esvaziamento Progressivo
app.post('/api/devices/:deviceId/drain', async (req, res) => {
    const { deviceId } = req.params;
    const entityId = `urn:ngsi-ld:Manhole:${deviceId}`;

    drainingDevices[entityId] = true;

    if (!activeSimulations[entityId]) {
        const backgroundDrain = setInterval(async () => {
            try {
                const orionRes = await axios.get(`${ORION_URL}/v2/entities/${entityId}`, { headers: fiwareHeaders });
                const entity = orionRes.data;
                let wl = entity.waterLevel ? entity.waterLevel.value : 0;

                wl = Math.max(40, wl - 8);

                await axios.post(`${IOTA_DATA_URL}/iot/json?k=${API_KEY}&i=${deviceId}`, {
                    wl: wl,
                    cs: entity.coverStatus ? entity.coverStatus.value : 'closed',
                    loc: entity.location.value,
                    lm: entity.lastMaintenance.value,
                    od: new Date().toISOString()
                });

                if (wl <= 40) {
                    clearInterval(backgroundDrain);
                    drainingDevices[entityId] = false;
                }
            } catch (err) {
                clearInterval(backgroundDrain);
                drainingDevices[entityId] = false;
            }
        }, 1500);
    }

    res.json({ message: 'Escoamento iniciado' });
});

// Iniciar Simulação Automática
app.post('/api/simulate/auto/start', async (req, res) => {
    const { deviceId, simulateRain, speed } = req.body;
    const entityId = `urn:ngsi-ld:Manhole:${deviceId}`;

    if (activeSimulations[entityId]) {
        return res.status(400).json({ error: 'Simulação já ativa.' });
    }

    let intervalMs = 2000;
    if (speed === 'lenta') intervalMs = 4000;
    if (speed === 'rapida') intervalMs = 500;

    activeSimulations[entityId] = setInterval(async () => {
        try {
            const orionRes = await axios.get(`${ORION_URL}/v2/entities/${entityId}`, { headers: fiwareHeaders });
            const entity = orionRes.data;

            let currentWl = entity.waterLevel ? entity.waterLevel.value : 0;
            let currentCs = entity.coverStatus ? entity.coverStatus.value : 'closed';

            if (drainingDevices[entityId]) {
                currentWl = Math.max(40, currentWl - 8);
                if (currentWl <= 40) {
                    drainingDevices[entityId] = false;
                }
            } else {
                if (simulateRain) {
                    currentWl = Math.min(100, currentWl + Math.floor(Math.random() * 8) + 2);
                } else {
                    currentWl = Math.max(0, currentWl - Math.floor(Math.random() * 4) + 1);
                }
            }

            const now = Date.now();
            const hasCooldown = coverCooldown[entityId] && (now - coverCooldown[entityId] < 300000);

            if (!hasCooldown && currentCs === 'closed' && Math.random() > 0.92) {
                currentCs = 'open';
            }

            await axios.post(`${IOTA_DATA_URL}/iot/json?k=${API_KEY}&i=${deviceId}`, {
                wl: currentWl,
                cs: currentCs,
                loc: entity.location.value,
                lm: entity.lastMaintenance.value,
                od: new Date().toISOString()
            });

        } catch (err) {
            console.error(`Erro simulação:`, err.message);
        }
    }, intervalMs);

    res.json({ message: `Simulação iniciada` });
});

// Parar Simulação Automática
app.post('/api/simulate/auto/stop', (req, res) => {
    const { deviceId } = req.body;
    const entityId = `urn:ngsi-ld:Manhole:${deviceId}`;

    if (activeSimulations[entityId]) {
        clearInterval(activeSimulations[entityId]);
        delete activeSimulations[entityId];
        res.json({ message: `Simulação parada` });
    } else {
        res.status(400).json({ error: 'Nenhuma simulação ativa.' });
    }
});

app.listen(PORT, () => {
    console.log(`🚀 Servidor rodando em http://localhost:${PORT}`);
    setTimeout(initFiware, 3000);
});
