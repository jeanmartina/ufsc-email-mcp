# UFSC Email MCP Server 📬

Servidor [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) para integração com o e-mail institucional da **Universidade Federal de Santa Catarina (UFSC)** (`imap.ufsc.br`) e outros servidores IMAP modernos.

Permite que assistentes de Inteligência Artificial (ChatGPT, Claude Desktop, Cursor, Orca, agentes n8n e outros) leiam, pesquisem, organizem, movam e marquem e-mails institucionais como lidos com segurança e rastreabilidade.

---

## ✨ Funcionalidades

- **Busca e Leitura de Mensagens:**
  - `list_messages`: Lista mensagens de qualquer pasta (`INBOX`, `SPAM`, subpastas personalizadas) com suporte a filtros e paginação.
  - `get_message`: Recupera o conteúdo completo do e-mail (texto puro, formatação e metadados).
  - `download_attachment`: Baixa e extrai texto de anexos (incluindo processamento seguro de PDFs e documentos DOCX).
- **Organização e Marcação de Mensagens:**
  - `mark_messages_read`: Marca mensagens como lidas (`seen: true`) ou não lidas (`seen: false`) via comandos IMAP `\Seen` de forma idempotente e segura por UID.
  - `move_messages`: Move mensagens individualmente ou em lote entre pastas, com o parâmetro opcional `mark_as_read: true` para marcar como lida e arquivar na mesma operação.
  - `save_draft`: Cria rascunhos de e-mails diretamente no servidor.
- **Dois Modos de Transporte MCP:**
  - **Stdio (Local):** Para clientes desktop (Claude Desktop, Cursor, VS Code, Orca local).
  - **Streamable HTTP / SSE (Remoto):** Servidor HTTP protegido por **Bearer Token** (`MCP_AUTH_TOKEN`) para conexão direta com ChatGPT, n8n, Traefik, Docker e integrações em nuvem.
- **Segurança e Conformidade:**
  - Utiliza estritamente **UIDs IMAP** para evitar inconsistências de sequência.
  - Suporte a carregamento de credenciais por variáveis de ambiente ou arquivos de segredo (`/config/password`).
  - Modo somente-leitura opcional (`IMAP_READ_ONLY=true`).

---

## ⚙️ Parâmetros do E-mail da UFSC

| Parâmetro         | Valor Recomendado           | Observações                                      |
| :---------------- | :-------------------------- | :----------------------------------------------- |
| **Servidor IMAP** | `imap.ufsc.br`              | Servidor oficial da SETIC/UFSC                   |
| **Porta**         | `993`                       | Porta segura padrão IMAP                         |
| **Segurança**     | `SSL/TLS` (`IMAP_TLS=true`) | Obrigatório para comunicação criptografada       |
| **Usuário**       | `seu.usuario@ufsc.br`       | Seu e-mail institucional ou identificador IdUFSC |
| **Senha**         | `sua-senha-idufsc`          | Senha de acesso ao IdUFSC                        |

---

## 🚀 Instalação e Preparação

### 1. Clonar o Repositório

```bash
git clone https://github.com/jeanmartina/ufsc-email-mcp.git
cd ufsc-email-mcp
```

### 2. Configurar Variáveis de Ambiente

Copie o arquivo de exemplo e preencha suas credenciais:

```bash
cp .env.example .env
```

Edite o `.env`:

```env
# Conexão IMAP da UFSC
IMAP_HOST=imap.ufsc.br
IMAP_PORT=993
IMAP_TLS=true
IMAP_USER=seu.idufsc@ufsc.br
IMAP_PASSWORD=sua_senha_idufsc
IMAP_READ_ONLY=false

# Configuração HTTP (para ChatGPT / Claude Remoto)
PORT=8087
HOST=0.0.0.0
MCP_AUTH_TOKEN=gere_um_token_seguro_aqui
```

### 3. Instalar Dependências e Compilar

Requer **Node.js >= 22**.

```bash
npm install
npm run build
```

---

## 🖥️ Como Executar

### Opção 1: Via Docker Compose (Recomendado para Servidor / ChatGPT)

A maneira mais simples de rodar como serviço contínuo:

```bash
docker compose up -d --build
```

O serviço iniciará na porta `8087` (ou na definida em `.env`) com suporte a Streamable HTTP e proteção por token.

### Opção 2: Como Servidor HTTP Local / Manual

```bash
npm run serve
# ou: node http-server.mjs
```

O endpoint HTTP estará disponível em:

- `http://localhost:8087/` (ou `/mcp`)
- Cabeçalho de autorização: `Authorization: Bearer <SEU_MCP_AUTH_TOKEN>`

### Opção 3: Modo Stdio no Claude Desktop

No seu arquivo `claude_desktop_config.json` (geralmente em `~/.config/Claude/claude_desktop_config.json` no Linux ou `%APPDATA%\Claude` no Windows):

```json
{
  "mcpServers": {
    "ufsc-email": {
      "command": "node",
      "args": ["/caminho/absoluto/ufsc-email-mcp/dist/index.js"],
      "env": {
        "IMAP_HOST": "imap.ufsc.br",
        "IMAP_PORT": "993",
        "IMAP_TLS": "true",
        "IMAP_USER": "seu.idufsc@ufsc.br",
        "IMAP_PASSWORD": "sua_senha_idufsc",
        "IMAP_READ_ONLY": "false"
      }
    }
  }
}
```

---

## 🤖 Conectando com o ChatGPT

Para conectar este MCP ao ChatGPT (via Custom GPT ou interface com suporte a MCP Streamable HTTP):

1. **URL do Servidor:** `https://seu-dominio-ou-ip/mcp`
2. **Tipo de Autenticação:** `Bearer Token`
3. **Token:** O mesmo valor configurado em `MCP_AUTH_TOKEN`.

---

## 🛠️ Ferramentas MCP Disponíveis (Tools Reference)

### 1. `mark_messages_read`

Marca uma ou mais mensagens como lidas ou não lidas na pasta informada.

```json
{
  "mailbox": "INBOX",
  "uids": [1024, 1025],
  "seen": true
}
```

### 2. `move_messages`

Move mensagens para uma pasta de destino, opcionalmente marcando-as como lidas.

```json
{
  "mailbox": "INBOX",
  "destination": "Arquivo",
  "uids": [1024],
  "mark_as_read": true
}
```

### 3. `list_messages`

Lista os e-mails com metadados e status de leitura.

```json
{
  "mailbox": "INBOX",
  "limit": 10
}
```

### 4. `get_message`

Lê o conteúdo completo de um e-mail através do seu UID.

```json
{
  "mailbox": "INBOX",
  "uid": 1024
}
```

### 5. `save_draft`

Cria um novo rascunho de e-mail na pasta de rascunhos.

```json
{
  "to": ["colegiado@ufsc.br"],
  "subject": "Parecer de Processo",
  "body": "Prezados,\n\nSegue parecer..."
}
```

### 6. `list_archive_entries` e `read_archive_entry`

Inspeciona com segurança arquivos `.zip` anexados (até `IMAP_MAX_ARCHIVE_BYTES`, padrão 32 MiB) e extrai texto paginado de PDFs (com rastreabilidade `== Page N ==`), DOCX, XLSX, PPTX, ODT, ODS, TXT, CSV, HTML, JSON, XML e RTF, ou materializa o arquivo original em diretório temporário isolado (`mode: "download"`).

### Choosing which tools load

Use `IMAP_ALLOW_TOOLS` and `IMAP_DENY_TOOLS` (see [Choosing which tools load](#choosing-which-tools-load)) to restrict exposed MCP tools in production deployments.

---

## 🧪 Testes Automatizados

O projeto inclui suíte completa de testes unitários e de integração utilizando [Vitest](https://vitest.dev/):

```bash
npm test
```

Para rodar os testes específicos de marcação e movimentação:

```bash
npx vitest run test/mark-messages-read.test.ts
```

---

## 📄 Licença

Distribuído sob a licença **MIT**. Veja o arquivo `LICENSE` para mais detalhes.
