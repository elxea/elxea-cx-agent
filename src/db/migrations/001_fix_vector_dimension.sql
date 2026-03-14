-- Migration: Fix vector dimension from 1536 (text-embedding-3-small) to 1024 (bge-m3)
-- The actual embedding model is @cf/baai/bge-m3 which outputs 1024 dimensions.

-- 1. Drop existing index
drop index if exists knowledge_chunks_embedding_idx;

-- 2. Alter column dimension
alter table knowledge_chunks
  alter column embedding type vector(1024);

-- 3. Recreate index
create index knowledge_chunks_embedding_idx
  on knowledge_chunks
  using ivfflat (embedding vector_cosine_ops)
  with (lists = 100);

-- 4. Recreate RPC function with correct dimension
create or replace function search_knowledge(
  query_embedding vector(1024),
  match_count int default 5,
  match_threshold float default 0.5
)
returns table (
  id uuid,
  content text,
  source_type text,
  source_title text,
  similarity float
)
language plpgsql
as $$
begin
  return query
  select
    kc.id,
    kc.content,
    kc.source_type,
    kc.source_title,
    1 - (kc.embedding <=> query_embedding) as similarity
  from knowledge_chunks kc
  where 1 - (kc.embedding <=> query_embedding) > match_threshold
  order by kc.embedding <=> query_embedding
  limit match_count;
end;
$$;
