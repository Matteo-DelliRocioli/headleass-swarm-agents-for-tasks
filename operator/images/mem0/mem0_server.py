"""
Mem0 REST API wrapper — exposes Mem0 Python SDK as HTTP endpoints.
Matches the API surface expected by orchestrator/src/mem0.ts and
opencode-config/tools/mem0-remember.ts / mem0-recall.ts.
"""

import os
import logging
from typing import Optional
from fastapi import FastAPI, Query
from pydantic import BaseModel

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("mem0-server")

# ---------------------------------------------------------------------------
# Mem0 initialization
# ---------------------------------------------------------------------------

qdrant_url = os.getenv("QDRANT_URL", "http://qdrant:6333")
qdrant_host = qdrant_url.replace("http://", "").replace("https://", "").split(":")[0]
qdrant_port = int(qdrant_url.split(":")[-1]) if ":" in qdrant_url.split("//")[-1] else 6333

config = {
    "llm": {
        "provider": "openai",
        "config": {
            "model": os.getenv("MEM0_LLM_MODEL", "gpt-4o-mini"),
            "api_key": os.getenv("OPENAI_API_KEY"),
        },
    },
    "embedder": {
        "provider": "openai",
        "config": {
            "model": os.getenv("MEM0_EMBEDDING_MODEL", "text-embedding-3-small"),
            "api_key": os.getenv("OPENAI_API_KEY"),
        },
    },
    "vector_store": {
        "provider": "qdrant",
        "config": {
            "host": qdrant_host,
            "port": qdrant_port,
            "collection_name": os.getenv("MEM0_COLLECTION", "swarm_memories"),
        },
    },
}

mem0 = None

def get_mem0():
    global mem0
    if mem0 is None:
        from mem0 import Memory
        mem0 = Memory.from_config(config)
        logger.info("Mem0 initialized with Qdrant at %s:%d", qdrant_host, qdrant_port)
    return mem0


# ---------------------------------------------------------------------------
# FastAPI app
# ---------------------------------------------------------------------------

app = FastAPI(title="Mem0 API", version="1.0.0")


class AddMemoryRequest(BaseModel):
    messages: list[dict]
    user_id: str
    agent_id: Optional[str] = None
    metadata: Optional[dict] = None


class SearchRequest(BaseModel):
    query: str
    user_id: str
    agent_id: Optional[str] = None
    limit: int = 20


@app.get("/health")
async def health():
    return {"status": "ok"}


@app.post("/v1/memories/")
async def add_memory(req: AddMemoryRequest):
    """Store a memory. Matches orchestrator/src/mem0.ts:addMemory()."""
    m = get_mem0()
    content = req.messages[0]["content"] if req.messages else ""

    kwargs = {"user_id": req.user_id}
    if req.agent_id:
        kwargs["agent_id"] = req.agent_id
    if req.metadata:
        kwargs["metadata"] = req.metadata

    try:
        result = m.add(content, **kwargs)
        # result can be a list of dicts or a dict
        if isinstance(result, list) and len(result) > 0:
            memory_id = result[0].get("id", "stored")
        elif isinstance(result, dict):
            memory_id = result.get("id", "stored")
        else:
            memory_id = "stored"

        logger.info("Stored memory for user=%s agent=%s", req.user_id, req.agent_id)
        return {"id": memory_id, "status": "ok"}
    except Exception as e:
        logger.error("Failed to store memory: %s", e)
        return {"id": None, "status": "error", "error": str(e)}


@app.post("/v1/memories/search/")
async def search_memories(req: SearchRequest):
    """Search memories. Matches orchestrator/src/mem0.ts:searchAll/searchAgent()."""
    m = get_mem0()

    kwargs = {"user_id": req.user_id, "limit": req.limit}
    if req.agent_id:
        kwargs["agent_id"] = req.agent_id

    try:
        results = m.search(req.query, **kwargs)
        # Normalize to list of dicts with id, memory, metadata
        memories = []
        if isinstance(results, list):
            for r in results:
                if isinstance(r, dict):
                    memories.append({
                        "id": r.get("id", ""),
                        "memory": r.get("memory", r.get("text", "")),
                        "metadata": r.get("metadata", {}),
                        "score": r.get("score", 0),
                    })
        return {"results": memories}
    except Exception as e:
        logger.error("Search failed: %s", e)
        return {"results": []}


@app.get("/v1/memories/")
async def get_memories(
    user_id: str = Query(...),
    agent_id: Optional[str] = Query(None),
    limit: int = Query(100),
):
    """Get all memories for a user/run. Matches orchestrator/src/mem0.ts:getRunMemories()."""
    m = get_mem0()

    kwargs = {"user_id": user_id}
    if agent_id:
        kwargs["agent_id"] = agent_id

    try:
        results = m.get_all(**kwargs)
        memories = []
        if isinstance(results, list):
            for r in results[:limit]:
                if isinstance(r, dict):
                    memories.append({
                        "id": r.get("id", ""),
                        "memory": r.get("memory", r.get("text", "")),
                        "metadata": r.get("metadata", {}),
                    })
        return {"memories": memories}
    except Exception as e:
        logger.error("Get memories failed: %s", e)
        return {"memories": []}
