# ⚡ Smart Drain Monitoring (FIWARE + Node.js)

Este é um projeto Full Stack (Node.js + Express + TailwindCSS) para o monitoramento inteligente de bueiros utilizando o ecossistema **FIWARE**. A aplicação realiza o provisionamento automático de componentes, registra novos bueiros via IoT Agent (JSON over HTTP), gerencia o Context Broker (Orion), assina a persistência temporal (QuantumLeap) e monitora tudo em tempo real através de um Dashboard interativo com simulador de chuva.

## Pré-requisitos

Antes de começar, certifique-se de ter instalado em sua máquina:

* **Docker** e **Docker Compose**
* **Node.js** (versão 18 ou superior)
* **NPM** (gerenciador de pacotes do Node)

## 🚀 Como Executar o Projeto

Siga os passos abaixo no terminal para rodar a aplicação:

### 1. Iniciar a Infraestrutura FIWARE (Docker)

Suba todos os containers necessários (Orion, IoT Agent, MongoDB, CrateDB, QuantumLeap e Grafana) em segundo plano:

```bash
docker compose up -d

```

### 2. Verificar o Status dos Containers

Garanta que todos os serviços estão de pé e rodando corretamente:

```bash
docker ps

```

### 3. Instalar as Dependências do Node.js

Se for a primeira vez rodando o projeto, instale os pacotes necessários:

```bash
npm install

```

### 4. Iniciar o Servidor Backend e Frontend

Inicie a aplicação Node.js. O próprio servidor se encarregará de fazer o *provisionamento inicial* (Service Group e Subscription) no FIWARE após 3 segundos:

```bash
npm start

```

## 🌐 Acesso à Aplicação

Assim que o servidor iniciar com sucesso, abra o seu navegador e acesse:

* **Dashboard Web:** `http://localhost:3080`
* **Componentes FIWARE (Portas expostas):**
  * **Orion Context Broker:** `http://localhost:1026`
  * **IoT Agent JSON (Norte):** `http://localhost:4041`
  * **IoT Agent JSON (Sul/Dados):** `http://localhost:7896`
  * **Grafana:** `http://localhost:3000`
