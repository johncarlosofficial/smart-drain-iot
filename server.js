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

// 1. Inicialização Automatizada do FIWARE (Service Group e Subscription)
async function initFiware() {
    try {
        console.log('🔄 Inicializando configurações no FIWARE...');
        
        // Criar Service Group
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

        // Criar Subscription para o QuantumLeap
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
        console.error('❌ Erro na comunicação inicial com o FIWARE. Certifique-se de que o Docker está rodando.', error.message);
    }
}

// 2. Buscar todos os bueiros do Orion Context Broker
app.get('/api/devices', async (req, res) => {
    try {
        const response = await axios.get(`${ORION_URL}/v2/entities?type=Manhole`, { headers: fiwareHeaders });
        
        // Formatar dados brutos do Orion para o Frontend
        const devices = response.data.map(entity => ({
            id: entity.id,
            deviceId: entity.id.split(':').pop(),
            waterLevel: entity.waterLevel ? entity.waterLevel.value : 0,
            coverStatus: entity.coverStatus ? entity.coverStatus.value : 'unknown',
            location: entity.location ? entity.location.value : null,
            lastMaintenance: entity.lastMaintenance ? entity.lastMaintenance.value : 'N/A',
            isSimulating: !!activeSimulations[entity.id]
        }));
        
        res.json(devices);
    } catch (error) {
        res.status(500).json({ error: 'Erro ao buscar dispositivos no Orion', details: error.message });
    }
});

// 3. Cadastrar novo dispositivo (IoT Agent)
app.post('/api/devices', async (req, res) => {
    const { deviceId, latitude, longitude, lastMaintenance } = req.body;
    
    if (!deviceId || !latitude || !longitude) {
        return res.status(400).json({ error: 'Campos obrigatórios ausentes.' });
    }

    try {
        const payload = {
            devices: [{
                device_id: deviceId,
                entity_name: `urn:ngsi-ld:Manhole:${deviceId}`,
                entity_type: "Manhole",
                protocol: "IoTA-JSON", // ✨ CORREÇÃO: Alterado de "PDI-IoTA-JSON" para "IoTA-JSON"
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

        // Envia para o IoT Agent Provision
        await axios.post(`${IOTA_URL}/iot/devices`, payload, { headers: fiwareHeaders });
        
        // Enviar payload inicial de provisionamento de dados (Southbound)
        await axios.post(`${IOTA_DATA_URL}/iot/json?k=${API_KEY}&i=${deviceId}`, {
            wl: 0,
            cs: "closed",
            loc: { type: "Point", coordinates: [parseFloat(longitude), parseFloat(latitude)] },
            lm: new Date(lastMaintenance || Date.now()).toISOString(),
            od: new Date().toISOString()
        });

        res.status(201).json({ message: `Dispositivo ${deviceId} registrado com sucesso!` });
    } catch (error) {
        // ✨ MELHORIA: Log detalhado no terminal do VS Code/Node para debug
        console.error('❌ Erro detalhado no cadastro FIWARE:', error.response?.data || error.message);
        
        // Repassa o status correto do erro (ex: 400 ou 409) em vez de mascarar tudo como 500
        const statusCode = error.response?.status || 500;
        res.status(statusCode).json({ 
            error: 'Erro ao registrar dispositivo', 
            details: error.response?.data || error.message 
        });
    }
});

// 4. Envio Manual de dados de Sensores (IoT Agent JSON)
app.post('/api/simulate/manual', async (req, res) => {
    const { deviceId, waterLevel, coverStatus } = req.body;
    try {
        // Busca a entidade atual para preservar a localização e manutenção anterior
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

// 5. Iniciar Simulação Automática de Chuva
app.post('/api/simulate/auto/start', async (req, res) => {
    const { deviceId, simulateRain, speed } = req.body;
    const entityId = `urn:ngsi-ld:Manhole:${deviceId}`;

    if (activeSimulations[entityId]) {
        return res.status(400).json({ error: 'Simulação já ativa para este bueiro.' });
    }

    // Define o intervalo em milissegundos baseado na velocidade informada
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
                // Aumenta o nível se simulando chuva até o teto de 100%
                currentWl = Math.min(100, currentWl + Math.floor(Math.random() * 8) + 2);
            } else {
                // Efeito de escoamento natural se não houver chuva simulada
                currentWl = Math.max(0, currentWl - Math.floor(Math.random() * 4) + 1);
            }

            // Simula ocasionalmente uma variação na abertura da tampa para dinamismo
            if (Math.random() > 0.92) {
                currentCs = currentCs === 'closed' ? 'open' : 'closed';
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

// 6. Parar Simulação Automática
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
    // Aguarda um pequeno delay para garantir que os containers do docker subiram por completo
    setTimeout(initFiware, 3000);
});
