const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = 3080;

// Configurações do FIWARE (Acessados via localhost a partir da aplicação externa)
const IOTA_URL = 'http://localhost:4041';
const IOTA_DATA_URL = 'http://localhost:7896';
const ORION_URL = 'http://localhost:1026';
const API_KEY = '1234';

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Headers padrões exigidos pelo FIWARE
const fiwareHeaders = {
    'fiware-service': 'openiot',
    'fiware-servicepath': '/'
};

// Armazenamento em memória para intervalos de simulação ativa
const activeSimulations = {};

// Função auxiliar para validar coordenadas
function isValidCoordinates(lat, lng) {
    return lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;
}

// 1. Inicialização Automatizada do FIWARE
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

// 2. Buscar todos os bueiros do Orion
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
            isSimulating: !!activeSimulations[entity.id]
        }));
        
        res.json(devices);
    } catch (error) {
        res.status(500).json({ error: 'Erro ao buscar dispositivos no Orion', details: error.message });
    }
});

// 3. Cadastrar novo dispositivo
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
        console.error('❌ Erro no cadastro FIWARE:', error.response?.data || error.message);
        res.status(error.response?.status || 500).json({ 
            error: 'Erro ao registrar dispositivo', 
            details: error.response?.data || error.message 
        });
    }
});

// 4. Editar Dispositivo Existente (Atualiza atributos e, se necessário, recria o ID)
app.put('/api/devices/:oldDeviceId', async (req, res) => {
    const { oldDeviceId } = req.params;
    const { deviceId, latitude, longitude, waterLevel, coverStatus, lastMaintenance } = req.body;

    if (!isValidCoordinates(parseFloat(latitude), parseFloat(longitude))) {
        return res.status(400).json({ error: 'Latitude ou longitude inválidas.' });
    }

    try {
        // Se o ID mudou, deletamos o antigo e provisionamos o novo
        if (oldDeviceId !== deviceId) {
            await axios.delete(`${IOTA_URL}/iot/devices/${oldDeviceId}`, { headers: fiwareHeaders }).catch(() => {});
            await axios.delete(`${ORION_URL}/v2/entities/urn:ngsi-ld:Manhole:${oldDeviceId}`, { headers: fiwareHeaders }).catch(() => {});

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
            
            // Para simulação antiga se houver
            if (activeSimulations[`urn:ngsi-ld:Manhole:${oldDeviceId}`]) {
                clearInterval(activeSimulations[`urn:ngsi-ld:Manhole:${oldDeviceId}`]);
                delete activeSimulations[`urn:ngsi-ld:Manhole:${oldDeviceId}`];
            }
        }

        // Injeta os novos dados para forçar a atualização dos atributos via IoT Agent
        await axios.post(`${IOTA_DATA_URL}/iot/json?k=${API_KEY}&i=${deviceId}`, {
            wl: parseInt(waterLevel),
            cs: coverStatus,
            loc: { type: "Point", coordinates: [parseFloat(longitude), parseFloat(latitude)] },
            lm: new Date(lastMaintenance || Date.now()).toISOString(),
            od: new Date().toISOString()
        });

        res.json({ message: 'Dispositivo atualizado com sucesso!' });
    } catch (error) {
        console.error('❌ Erro na edição FIWARE:', error.message);
        res.status(500).json({ error: 'Erro ao atualizar dispositivo.', details: error.message });
    }
});

// 5. Envio Manual de dados de Sensores
app.post('/api/simulate/manual', async (req, res) => {
    const { deviceId, waterLevel, coverStatus } = req.body;
    try {
        const orionRes = await axios.get(`${ORION_URL}/v2/entities/urn:ngsi-ld:Manhole:${deviceId}`, { headers: fiwareHeaders });
        const currentEntity = orionRes.data;

        const payload = {
            wl: parseInt(waterLevel),
            cs: coverStatus,
            loc: currentEntity.location.value,
            lm: currentEntity.lastMaintenance.value,
            od: new Date().toISOString()
        };

        await axios.post(`${IOTA_DATA_URL}/iot/json?k=${API_KEY}&i=${deviceId}`, payload);
        res.json({ message: 'Dados enviados com sucesso!' });
    } catch (error) {
        res.status(500).json({ error: 'Erro ao enviar dados manuais', details: error.message });
    }
});

// 6. Iniciar Simulação Automática de Chuva
app.post('/api/simulate/auto/start', async (req, res) => {
    const { deviceId, simulateRain, speed } = req.body;
    const entityId = `urn:ngsi-ld:Manhole:${deviceId}`;

    if (activeSimulations[entityId]) {
        return res.status(400).json({ error: 'Simulação já ativa para este bueiro.' });
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

            if (simulateRain) {
                currentWl = Math.min(100, currentWl + Math.floor(Math.random() * 8) + 2);
            } else {
                currentWl = Math.max(0, currentWl - Math.floor(Math.random() * 4) + 1);
            }

            // MODIFICAÇÃO: A tampa abre aleatoriamente e NÃO FECHA automaticamente.
            if (currentCs === 'closed' && Math.random() > 0.92) {
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
            console.error(`Erro na simulação do dispositivo ${deviceId}:`, err.message);
        }
    }, intervalMs);

    res.json({ message: `Simulação iniciada para ${deviceId}` });
});

// 7. Parar Simulação Automática
app.post('/api/simulate/auto/stop', (req, res) => {
    const { deviceId } = req.body;
    const entityId = `urn:ngsi-ld:Manhole:${deviceId}`;

    if (activeSimulations[entityId]) {
        clearInterval(activeSimulations[entityId]);
        delete activeSimulations[entityId];
        res.json({ message: `Simulação parada para ${deviceId}` });
    } else {
        res.status(400).json({ error: 'Nenhuma simulação ativa para este dispositivo.' });
    }
});

app.listen(PORT, () => {
    console.log(`🚀 Servidor rodando em http://localhost:${PORT}`);
    setTimeout(initFiware, 3000);
});
