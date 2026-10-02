<div align="center">
  <img src="public/assets/icons/logo-512.jpg" alt="MindFlip AI Logo" width="120" height="120" style="border-radius: 20px;">
  
  # MindFlip AI

  ### Don't Just Study. MindFlip.
  
  **A backend-focused service for AI-powered flashcard generation and study assistance.**
</div>


This project implements a **Clean Architecture** API that leverages LLMs (WebLLM-first with quality gate and Ollama fallback) plus optional web search (Serper) to generate high-quality educational content. Frontend is a reference SPA that now supports PDF-only generation/quiz, prefetched quizzes, and settings-driven runtime selection.

### Current Architecture Snapshot

```mermaid
graph TB
    subgraph "Clients"
        WEB["Web Frontend<br/>(Reference SPA)"]
        MOBILE["Mobile App<br/>(Expo/React Native)"]
    end

    subgraph "API Gateway"
        EXPRESS["Express Server<br/>:3000"]
        GQL["GraphQL API<br/>/graphql"]
        REST["REST API<br/>/api/*"]
    end

    subgraph "Core Services"
        STUDY["Study Service"]
        QUEUE["BullMQ Queue"]
        CACHE["Redis Cache"]
        RAG["RAG Service"]
    end

    subgraph "Data Layer"
        VECTOR["Upstash Vector<br/>(Embeddings)"]
        GRAPH["Neo4j<br/>(Knowledge Graph)"]
        POSTGRES["PostgreSQL<br/>(Users/Decks)"]
    end

    subgraph "AI Layer"
        HYBRID["Hybrid AI Adapter"]
        OLLAMA["Ollama (Local)"]
        WEBLLM["WebLLM (Browser)"]
        SERPER["Serper (Web Search)"]
        MCP["MCP Server (Optional)"]
    end

    %% Client Connections
    WEB --> REST
    WEB --> GQL
    MOBILE --> REST
    MOBILE --> GQL

    %% API to Services
    EXPRESS --> REST
    EXPRESS --> GQL
    REST --> STUDY
    GQL --> STUDY

    %% Service Logic
    STUDY --> QUEUE
    STUDY --> CACHE
    STUDY --> HYBRID
    STUDY --> RAG

    %% RAG Pipeline
    RAG --> VECTOR
    RAG --> GRAPH
    RAG --> HYBRID

    %% AI Routing
    HYBRID -->|Preferred| OLLAMA
    HYBRID -->|Client-side| WEBLLM
    HYBRID -->|Context| SERPER
    HYBRID -.->|Tools| MCP
    
    %% Queue Processing
    QUEUE --> STUDY
```

## Type Safety & Code Quality
- TypeScript strict mode is enabled (noImplicitAny, strictNullChecks, noUnusedLocals/Params, noFallthroughCasesInSwitch).
- Prefer `unknown` over `any`; add type guards at API/LLM boundaries. See `src/adapters/primary/express/validators.ts` for request guards.
- Core models are readonly and use literal unions for runtimes (`ollama` | `webllm`) and knowledge sources.
- ESLint config (`.eslintrc.cjs`) enforces: no explicit `any`, prefer-readonly, no non-null assertions, explicit return types for exported APIs.
- When adding routes, include a small runtime validator before using request bodies; keep assertions to a minimum.

## 🏗 Architecture

The system follows **Clean Architecture** principles to ensure separation of concerns, maintainability, and testability:

- **Core (Domain)**: Contains business logic and interfaces.
  - `StudyService`: Orchestrates generation, quiz creation, and deep dive logic.
  - `MetricsService`: Tracks usage and performance metrics.
- **Ports**: Defines interfaces for external dependencies.
  - `StudyUseCase`: Primary port for the application.
  - `LLMPort`, `SearchPort`: Secondary ports for AI and Search services.
- **Adapters**: Implements the ports.
  - **Primary**: 
    - `Express Server` (REST API).
    - `Apollo Server` (GraphQL API).
  - **Secondary**: 
    - `HybridOllamaAdapter`: Connects to Ollama via MCP or direct (with fallback).
    - `WebLLMAdapter`: Connects to browser-based LLM (via client bridge).
    - `HybridSerperAdapter`: Connects to Serper.dev via MCP or direct (with fallback).
    - `FileSystemAdapter`: Handles file I/O.
    - `SubscriptionService`: Handles real-time updates via PubSub (WebSocket ready).
    - **Runtime Preference + Fallback**: User-selectable runtime (Ollama or WebLLM). Server tries preferred runtime → alternate runtime → local fallback.
- **MCP Layer** (Optional, Feature Flag):
  - `MCPClientWrapper`: Connects to MCP server with circuit breaker.
  - `MCP Server`: Standalone process with tools for Ollama, Serper, etc.
  - Automatic fallback to direct adapters on failure.
- **Resilience Layer**:
  - `QueueService` (BullMQ): Background job processing with retry and DLQ.
  - `ResilienceService` (Opossum): Circuit breakers for external dependencies.
  - `LoggerService` (Winston): Structured logging.
  - `FlashcardCacheService`: In-memory cache for instant repeated queries.

### Request Flow

```mermaid
sequenceDiagram
    participant C as Client
    participant API as Express Server
    participant Q as Queue (BullMQ)
    participant W as Worker
    participant CB as Circuit Breaker
    participant EXT as External API
    participant R as Redis

    C->>API: POST /api/generate
    API->>Q: Add Job
    Q->>R: Store Job
    API-->>C: 202 Accepted (jobId)
    C->>API: GET /api/jobs/:id (poll)
    API->>Q: Get Job Status
    Q->>R: Query Job
    API-->>C: Status: waiting/active/completed
    
    Note over W: Background Processing
    W->>Q: Pull Job
    W->>CB: Execute via Circuit Breaker
    alt Circuit Closed
        CB->>EXT: Call External API
        EXT-->>CB: Response
        CB-->>W: Success
    else Circuit Open
        CB-->>W: Fallback/Error
    end
    W->>Q: Update Job (completed/failed)
    
    C->>API: GET /api/jobs/:id
    API->>Q: Get Result
    API-->>C: 200 OK (cards)
```

### Resilience Patterns

```mermaid
graph TB
    Request["API Request"] --> RateLimit["fa:fa-shield Rate Limiter"]
    RateLimit --> Auth["fa:fa-lock Authentication"]
    Auth --> Queue["fa:fa-list Queue (BullMQ)"]
    Queue --> Worker["fa:fa-cog Worker"]
    Worker --> CircuitBreaker["fa:fa-bolt Circuit Breaker"]
    
    CircuitBreaker -->|Closed| ExternalAPI["fa:fa-server External API"]
    CircuitBreaker -->|Open| Fallback["fa:fa-life-ring Fallback"]
    
    Worker -->|Success| CompleteJob["fa:fa-check Complete Job"]
    Worker -->|Failure| Retry{"Retry?"}
    Retry -->|Yes, Backoff| Queue
    Retry -->|No, Exhausted| DLQ["fa:fa-skull Dead Letter Queue"]
    
    style Queue fill:#e1f5ff
    style CircuitBreaker fill:#fff3cd
    style DLQ fill:#f8d7da
```

## 📖 API Documentation

### REST API

Interactive API documentation is available via **Swagger UI**:

- **URL**: `http://localhost:3000/api-docs`
- **Specification**: `swagger.yaml`

Explore and test all endpoints directly from your browser.

### GraphQL API ✨ NEW

The application now supports a modern GraphQL API alongside REST:

- **Endpoint**: `http://localhost:3000/graphql`
- **Documentation**: See [docs/graphql-api.md](docs/graphql-api.md) | [Examples](docs/graphql-examples.md)
- **Playground**: Apollo Sandbox available in development at `/graphql`

**Key Features:**
- 🔀 **Hybrid Mode**: Automatic fallback to REST API if GraphQL fails
- 🔐 **Full Authentication**: JWT-based auth for protected operations
- ⚡ **Efficient Queries**: Request only the data you need
- 🎯 **Type Safety**: GraphQL schema with strong typing
- 📦 **Batching Support**: Multiple operations in single request

**Enable GraphQL Mode:**
```javascript
localStorage.setItem('USE_GRAPHQL', 'true');
location.reload();
```

**LLM Runtime Preference (NEW):**
- Choose preferred runtime (Ollama or WebLLM) in the in-app **Settings** modal (header → Settings).
- The app will try your preference first, then automatically fall back to the other runtime, then to a local quiz fallback.

**Compare APIs:**
```bash
# REST: Multiple requests for deck + cards
curl /api/decks
curl /api/decks/:id

# GraphQL: Single request
curl -X POST /graphql -d '{
  "query": "{ deck(id: \"abc\") { topic cards { front back } } }"
}'
```

## ✨ Key Features

### Security & Authentication
- 🔐 **OAuth 2.0** (Google) for user authentication
- 🔒 **JWE Token Encryption** for secure sessions
- 🛡️ **Rate Limiting** (API: 100/15min, Auth: 5/hour)
- ✅ **Auth Middleware** protecting sensitive endpoints

### Performance & Resilience
- ⚡ **In-Memory Caching** for instant repeated queries (1 hour TTL)
- 🌐 **Cache-First Web Search** - 24hr cache for web content (Phase 5)
- 🔄 **Background Queue** with retry and Dead Letter Queue (BullMQ)
- 🔌 **Circuit Breakers** preventing cascading failures (Opossum)
- 📊 **Structured Logging** for observability (Winston)
- 🎯 **Proactive Deep Dive** - auto-generates related topics in background
- 🎓 **Async Recommendations** - background generation of quiz topics & learning paths (Phase 5)

### MCP Integration (Optional)
- 🌐 **Model Context Protocol** server for external service calls
- 🔀 **Hybrid Adapters** with automatic fallback
- 🚦 **Feature Flag** (`USE_MCP_SERVER`) for safe rollout
- 💪 **Zero Downtime** - works with or without MCP

### AI & Search
- 🤖 Multiple LLM runtimes (Ollama, WebLLM)
- 🔍 Web search integration (Serper) with cache-first strategy
- 📄 PDF/Image processing for flashcard generation
- 🎓 Quiz generation from flashcards
- 💪 **Advanced Quiz Mode** - "Try Harder Quiz" with web-enhanced context (Phase 5)
- ✅ Validation & Self-Repair: Generated flashcards are validated for strict JSON/question-answer shape; if invalid/insufficient, the system re-prompts the runtime to repair before returning.
- 📏 Count Enforcement: Returned flashcards are trimmed/padded to match the requested count; client-side generation auto-falls back to backend if underfilled.
- 🛡️ Runtime fallback ladder: Preferred runtime (configurable) → alternate runtime → local quiz fallback to prevent failures when an LLM is unavailable
- 📱 **Mobile-Responsive**: Swipe gestures for flashcard study; collapsible header with hamburger menu on mobile
- 🗂️ **Deck History**: Persistent deck history that survives page reloads
- 🎓 **Quiz from Flashcards**: Select specific cards from a deck to create a custom quiz

### RAG Pipeline (NEW)
- 🧠 **Retrieval-Augmented Generation** for context-aware flashcard generation
- 📊 **Hybrid Search**: Combines vector similarity (Upstash) + graph traversal (Neo4j)
- 🔗 **Knowledge Graph**: Entities and relationships extracted from ingested content
- 📚 **Content Ingestion**: Upload PDFs/text → chunked → embedded → stored in vector DB + graph
- ⚡ **LangGraph Orchestration**: Multi-step RAG workflow with state management


## 🚀 Getting Started

### Prerequisites
- **Node.js** ≥ 18 (tested with v22)
- **Docker** (recommended for local databases)
- **Ollama** (optional, for local LLM - default model: llama3.2:latest)

> **Note**: This project uses `tsx` for TypeScript execution in development mode, which provides better compatibility with Node.js v22+ and ESM modules.

### Installation

1. **Clone the repository**
   ```bash
   git clone <repository-url>
   cd flash-card-study-helper-ai
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Start Docker Services** (Recommended)
   ```bash
   # Start PostgreSQL, Neo4j, Qdrant (Vector DB), and Redis
   docker compose up -d
   
   # Verify services are running
   docker compose ps
   ```
   
   | Service | Port | Credentials |
   |---------|------|-------------|
   | PostgreSQL | 5432 | `flashcard` / `flashcard_dev` |
   | Neo4j | 7687, 7474 | `neo4j` / `flashcard_dev` |
   | Qdrant | 6333, 6334 | N/A |
   | Redis | 6379 | N/A |

4. **Configure Environment**
   ```bash
   cp .env.example .env
   ```
   
   **Required Variables:**
   ```bash
   # Google OAuth (for authentication)
   GOOGLE_CLIENT_ID=your_client_id
   GOOGLE_CLIENT_SECRET=your_client_secret
   
   # JWE Token Encryption
   JWE_SECRET_KEY=your_32_char_secret_key
   
   # Serper API (for web search)
   SERPER_API_KEY=your_serper_api_key
   
   # Ollama Configuration
   OLLAMA_BASE_URL=http://localhost:11434
   OLLAMA_MODEL=llama3.2:latest
   
   # Neo4j (Knowledge Graph for RAG)
   NEO4J_URI=bolt://localhost:7687
   NEO4J_USER=neo4j
   NEO4J_PASSWORD=flashcard_dev
   
   # Redis (for queue) - auto-configured with Docker
   REDIS_HOST=localhost
   REDIS_PORT=6379
   
   # MCP Feature Flag (optional, default: false)
   USE_MCP_SERVER=false
   ```

### Running the Service

**Development Mode** (Recommended for development)
```bash
# Start Redis
brew services start redis  # or docker run -p 6379:6379 redis

# Run in development mode (uses tsx for hot TypeScript execution)
npm run dev
```

**Production Mode**
```bash
# Build backend and frontend
npm run build:all

# Start Redis
brew services start redis  # or docker run -p 6379:6379 redis

# Start server
npm run serve
```

**With MCP Server** (Optional)
```bash
# Build MCP server
npx tsc -p mcp-server/tsconfig.json

# Enable MCP
export USE_MCP_SERVER=true

# Start in development mode
npm run dev
```

### Deploying to Vercel

The app is designed to run on Vercel's serverless platform:

```bash
# Install Vercel CLI
npm i -g vercel

# Deploy
vercel
```

**Required Environment Variables on Vercel:**

| Variable | Description |
|----------|-------------|
| `GOOGLE_CLIENT_ID` | Google OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | Google OAuth secret |
| `JWE_SECRET_KEY` | 32-char encryption key |
| `SERPER_API_KEY` | Serper.dev API key |
| `OLLAMA_BASE_URL` | Remote Ollama endpoint (e.g., ngrok tunnel) |

**Optional RAG Variables (for RAG features):**

| Variable | Service | Description |
|----------|---------|-------------|
| `NEO4J_URI` | [Neo4j Aura](https://neo4j.com/cloud/aura/) | `neo4j+s://xxx.databases.neo4j.io` |
| `NEO4J_USER` | Neo4j Aura | Usually `neo4j` |
| `NEO4J_PASSWORD` | Neo4j Aura | Your Aura password |
| `UPSTASH_VECTOR_REST_URL` | [Upstash](https://upstash.com) | Vector REST endpoint |
| `UPSTASH_VECTOR_REST_TOKEN` | Upstash | Vector API token |
| `REDIS_URL` | [Upstash Redis](https://upstash.com) | For queue persistence |

> **Note**: Without RAG variables, the app works in "basic mode" using web search for context. With RAG variables, the app enables knowledge graph and vector search for enhanced flashcard generation.

- **API Root**: `http://localhost:3000/api`
- **Swagger UI**: `http://localhost:3000/api-docs`
- **Demo Client**: `http://localhost:3000` (Quiz now lives inside the SPA; `Take Quiz` no longer redirects to `quiz.html`)
- **Health Check**: `http://localhost:3000/api/health`

## 📡 Key API Endpoints

### Flashcard Generation
| Method | Endpoint | Description | Auth |
| --- | --- | --- | --- |
| **POST** | `/api/generate` | Generate flashcards (async, returns jobId) | Yes |
| **POST** | `/api/generate/from-content` | Generate directly from Text/URL | Yes |
| **GET** | `/api/jobs/:id` | Poll job status and retrieve results | Yes |
| **POST** | `/api/upload` | Upload PDF/Image for processing | Yes |

### Authentication
| Method | Endpoint | Description | Auth |
| --- | --- | --- | --- |
| **GET** | `/api/auth/google` | Initiate Google OAuth flow | No |
| **GET** | `/api/auth/google/callback` | OAuth callback (returns JWE token) | No |

### Admin & Monitoring
| Method | Endpoint | Description | Auth |
| --- | --- | --- | --- |
| **GET** | `/api/health` | Service health check | No |
| **GET** | `/api/queue/stats` | Queue statistics (jobs processed, DLQ, etc.) | Yes |
| **GET** | `/api-docs` | Interactive Swagger UI documentation | No |

*See Swagger UI for complete API reference and request/response schemas.*

## 🤖 AI Integration

The service supports multiple AI runtimes:

1.  **Ollama (Server-side)** - Default
    - Runs locally on the server
    - Powerful models (llama3.2, mistral, etc.)
    - Can use MCP server or direct connection
    - Configured via `.env`

2.  **WebLLM (Client-side)**
    - Runs in user's browser (WebGPU)
    - Zero server cost
    - Always uses direct connection (no MCP)

### MCP Architecture (Optional)

```mermaid
graph LR
    Request[API Request] --> Hybrid[Hybrid Adapter]
    Hybrid --> |MCP Enabled| MCPClient[MCP Client + Circuit Breaker]
    Hybrid --> |MCP Disabled/Failed| Direct[Direct Adapter]
    
    MCPClient --> |Success| MCPServer[MCP Server]
    MCPClient --> |Failure| Direct
    
    MCPServer --> Ollama[Ollama API]
    MCPServer --> Serper[Serper API]
    
    Direct --> Ollama
    Direct --> Serper
    
    style MCPClient fill:#fff3cd
    style Direct fill:#d4edda
```

**Benefits:**
- Standardized interface for all external services
- Circuit breaker on all MCP calls
- Automatic fallback to direct adapters
- Zero breaking changes (opt-in via feature flag)

## 🛠 Project Structure

```bash
flash-card-study-helper-ai/
├── mcp-server/          # MCP Server (Optional)
│   ├── tools/           # MCP Tools (Ollama, Serper, etc.)
│   └── index.ts         # MCP Server Entry Point
├── src/
│   ├── adapters/
│   │   ├── primary/     # Express Server, Middleware
│   │   └── secondary/   # External Service Adapters
│   │       ├── mcp/     # MCP Client Wrapper
│   │       ├── ollama/  # Ollama Adapters (Direct + Hybrid)
│   │       └── serper/  # Serper Adapters (Direct + Hybrid)
│   ├── core/
│   │   ├── domain/      # Business Models
│   │   ├── ports/       # Interface Definitions
│   │   └── services/    # Core Business Logic
│   ├── graphql/         # GraphQL API (New)
│   │   ├── resolvers/   # Query/Mutation resolvers
│   │   ├── schema/      # Type definitions
│   │   └── plugins/     # Apollo plugins
│   └── index.ts         # Composition Root
├── public/              # Frontend Demo
├── tests/               # Unit & Integration Tests
└── swagger.yaml         # OpenAPI Specification
```

## 🧪 Testing

```bash
# Run all tests
npm test

# Run with coverage
npm test -- --coverage
```

**Test Coverage:**
- ✅ Unit tests for all core services (Cache, Auth, Resilience)
- ✅ Integration tests for API endpoints
- ✅ Workflow tests for cache-queue integration

## 🔧 Configuration Reference

### Feature Flags

| Variable | Default | Description |
|----------|---------|-------------|
| `USE_MCP_SERVER` | `false` | Enable MCP server integration |

### Caching

| Variable | Default | Description |
|----------|---------|-------------|
| `CACHE_LLM_TTL_SECONDS` | `86400` | LLM response cache TTL (1 day) |
| `CACHE_SERPER_TTL_SECONDS` | `3600` | Serper result cache TTL (1 hour) |

### Rate Limiting

- API endpoints: 100 requests per 15 minutes
- Auth endpoints: 5 requests per hour

## 📊 Monitoring

### Health Check
```bash
curl http://localhost:3000/api/health
# Response: {"ollama":true,"serper":true}
```

### Queue Stats
```bash
curl -H "Authorization: Bearer <token>" \
  http://localhost:3000/api/queue/stats
```

### Logs
- **Console**: Structured JSON logs (Winston)
- **Files**: `error.log`, `combined.log`

## 📝 License

MIT
