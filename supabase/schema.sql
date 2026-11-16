-- =============================================================================
-- Questionario ISD — schema Supabase (PostgreSQL)
--
-- Eseguire per intero nel SQL Editor del progetto Supabase. Lo script è
-- idempotente: può essere rieseguito per aggiornare le funzioni.
--
-- Principi:
--  * Nessuna tabella è accessibile direttamente via API: ruoli `anon` e
--    `authenticated` non hanno privilegi sulle tabelle (e RLS è attivo senza
--    policy). Tutto passa da funzioni SECURITY DEFINER che validano l'input.
--  * Anonimato: i link sono salvati solo come hash SHA-256 e vengono ELIMINATI
--    quando usati; le risposte hanno ID casuale e nessun timestamp, e non hanno
--    alcun riferimento al link.
--  * Amministratori: utenti Supabase Auth presenti nella tabella `admins`.
-- =============================================================================

create table if not exists public.admins (
  user_id uuid primary key references auth.users(id) on delete cascade
);

create table if not exists public.questionnaires (
  id          bigint generated always as identity primary key,
  title       text   not null check (char_length(title) between 1 and 200),
  description text   not null default '' check (char_length(description) <= 5000),
  status      text   not null default 'draft' check (status in ('draft','open','closed')),
  created_at  timestamptz not null default now()
);

create table if not exists public.questions (
  id               bigint generated always as identity primary key,
  questionnaire_id bigint not null references public.questionnaires(id) on delete cascade,
  position         int    not null,
  type             text   not null check (type in ('open','single','multiple')),
  text             text   not null check (char_length(text) between 1 and 1000),
  required         boolean not null default true
);
create index if not exists questions_q_idx on public.questions(questionnaire_id, position);

create table if not exists public.options (
  id          bigint generated always as identity primary key,
  question_id bigint not null references public.questions(id) on delete cascade,
  position    int    not null,
  text        text   not null check (char_length(text) between 1 and 300)
);
create index if not exists options_q_idx on public.options(question_id, position);

-- Solo link NON ancora usati. Un link usato viene cancellato.
create table if not exists public.tokens (
  token_hash       text   primary key,
  questionnaire_id bigint not null references public.questionnaires(id) on delete cascade
);
create index if not exists tokens_q_idx on public.tokens(questionnaire_id);

-- Nessun timestamp, nessun riferimento al link.
create table if not exists public.responses (
  id               uuid   primary key default gen_random_uuid(),
  questionnaire_id bigint not null references public.questionnaires(id) on delete cascade
);
create index if not exists responses_q_idx on public.responses(questionnaire_id);

create table if not exists public.answers_text (
  response_id uuid   not null references public.responses(id) on delete cascade,
  question_id bigint not null references public.questions(id) on delete cascade,
  value       text   not null check (char_length(value) between 1 and 5000),
  primary key (response_id, question_id)
);
create index if not exists answers_text_q_idx on public.answers_text(question_id);

create table if not exists public.answers_choice (
  response_id uuid   not null references public.responses(id) on delete cascade,
  question_id bigint not null references public.questions(id) on delete cascade,
  option_id   bigint not null references public.options(id) on delete cascade,
  primary key (response_id, option_id)
);
create index if not exists answers_choice_q_idx on public.answers_choice(question_id);

-- ----------------------------------------------------------------- permessi
alter table public.admins          enable row level security;
alter table public.questionnaires  enable row level security;
alter table public.questions       enable row level security;
alter table public.options         enable row level security;
alter table public.tokens          enable row level security;
alter table public.responses       enable row level security;
alter table public.answers_text    enable row level security;
alter table public.answers_choice  enable row level security;

revoke all on public.admins, public.questionnaires, public.questions, public.options,
  public.tokens, public.responses, public.answers_text, public.answers_choice
  from anon, authenticated;

-- ================================================================== utilità

create or replace function public._hash_token(p_token text)
returns text language sql stable
set search_path = pg_catalog
as $$ select encode(sha256(convert_to(p_token, 'UTF8')), 'hex') $$;

create or replace function public._is_admin()
returns boolean language sql stable security definer
set search_path = public, pg_catalog
as $$ select exists (select 1 from public.admins where user_id = auth.uid()) $$;

create or replace function public._require_admin()
returns void language plpgsql stable security definer
set search_path = public, pg_catalog
as $$
begin
  if not public._is_admin() then
    raise exception 'Accesso riservato agli amministratori.' using errcode = '42501';
  end if;
end $$;

/** Struttura del questionario (domande e opzioni) in JSON. */
create or replace function public._questions_json(p_id bigint)
returns jsonb language sql stable security definer
set search_path = public, pg_catalog
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', q.id, 'type', q.type, 'text', q.text, 'required', q.required,
      'options', coalesce((
        select jsonb_agg(jsonb_build_object('id', o.id, 'text', o.text) order by o.position, o.id)
        from public.options o where o.question_id = q.id), '[]'::jsonb)
    ) order by q.position, q.id), '[]'::jsonb)
  from public.questions q where q.questionnaire_id = p_id
$$;

-- ======================================================= area pubblica (anon)

/**
 * Restituisce il questionario associato al link.
 * status: ok | invalid (inesistente, revocato o già usato) | draft | closed
 */
create or replace function public.get_survey(p_token text)
returns jsonb language plpgsql stable security definer
set search_path = public, pg_catalog
as $$
declare
  v_q public.questionnaires;
begin
  if p_token is null or p_token !~ '^[A-Za-z0-9_-]{16,64}$' then
    return jsonb_build_object('status', 'invalid');
  end if;
  select q.* into v_q
    from public.tokens t join public.questionnaires q on q.id = t.questionnaire_id
   where t.token_hash = public._hash_token(p_token);
  if not found then
    return jsonb_build_object('status', 'invalid');
  end if;
  if v_q.status <> 'open' then
    return jsonb_build_object('status', v_q.status);
  end if;
  return jsonb_build_object(
    'status', 'ok',
    'questionnaire', jsonb_build_object(
      'title', v_q.title, 'description', v_q.description,
      'questions', public._questions_json(v_q.id)));
end $$;

/**
 * Valida e registra una risposta consumando il link, in un'unica transazione.
 * p_answers: { "<questionId>": "testo" | [optionId, ...] }
 * Ritorna { status: ok | invalid | draft | closed | errors, errors?: { "<questionId>": "messaggio" } }
 */
create or replace function public.submit_response(p_token text, p_answers jsonb)
returns jsonb language plpgsql volatile security definer
set search_path = public, pg_catalog
as $$
declare
  v_hash   text;
  v_qid    bigint;
  v_status text;
  v_q      record;
  v_val    jsonb;
  v_text   text;
  v_ids    bigint[];
  v_valid  bigint[];
  v_errors jsonb := '{}'::jsonb;
  v_rid    uuid;
  v_texts  jsonb := '[]'::jsonb;
  v_choice jsonb := '[]'::jsonb;
begin
  if p_token is null or p_token !~ '^[A-Za-z0-9_-]{16,64}$' then
    return jsonb_build_object('status', 'invalid');
  end if;
  if p_answers is null or jsonb_typeof(p_answers) <> 'object' then
    p_answers := '{}'::jsonb;
  end if;
  v_hash := public._hash_token(p_token);

  -- Blocca la riga del link: invii concorrenti con lo stesso link si serializzano qui.
  select t.questionnaire_id into v_qid from public.tokens t where t.token_hash = v_hash for update;
  if not found then
    return jsonb_build_object('status', 'invalid');
  end if;
  select status into v_status from public.questionnaires where id = v_qid for share;
  if v_status <> 'open' then
    return jsonb_build_object('status', v_status);
  end if;

  for v_q in select id, type, required from public.questions where questionnaire_id = v_qid order by position loop
    v_val := p_answers -> v_q.id::text;

    if v_q.type = 'open' then
      v_text := case when jsonb_typeof(v_val) = 'string' then btrim(v_val #>> '{}', E' \t\r\n') else '' end;
      v_text := replace(v_text, E'\r\n', E'\n');
      if v_text = '' then
        if v_q.required then v_errors := v_errors || jsonb_build_object(v_q.id::text, 'Questa domanda è obbligatoria.'); end if;
      elsif char_length(v_text) > 5000 then
        v_errors := v_errors || jsonb_build_object(v_q.id::text, 'La risposta supera 5000 caratteri.');
      else
        v_texts := v_texts || jsonb_build_array(jsonb_build_object('q', v_q.id, 'v', v_text));
      end if;
      continue;
    end if;

    -- Domande chiuse: array di id opzione
    if v_val is null or jsonb_typeof(v_val) = 'null' then
      v_ids := '{}';
    elsif jsonb_typeof(v_val) <> 'array'
       or exists (select 1 from jsonb_array_elements(v_val) e
                   where jsonb_typeof(e) <> 'number' or (e #>> '{}') !~ '^[0-9]{1,18}$') then
      v_errors := v_errors || jsonb_build_object(v_q.id::text, 'Risposta non valida.');
      continue;
    else
      select coalesce(array_agg(distinct (e #>> '{}')::bigint), '{}')
        into v_ids from jsonb_array_elements(v_val) e;
    end if;

    select coalesce(array_agg(id), '{}') into v_valid from public.options where question_id = v_q.id;
    if not (v_ids <@ v_valid) then
      v_errors := v_errors || jsonb_build_object(v_q.id::text, 'Risposta non valida.');
    elsif v_q.type = 'single' and cardinality(v_ids) > 1 then
      v_errors := v_errors || jsonb_build_object(v_q.id::text, 'Seleziona una sola risposta.');
    elsif cardinality(v_ids) = 0 then
      if v_q.required then v_errors := v_errors || jsonb_build_object(v_q.id::text, 'Questa domanda è obbligatoria.'); end if;
    else
      v_choice := v_choice || (select jsonb_agg(jsonb_build_object('q', v_q.id, 'o', x)) from unnest(v_ids) x);
    end if;
  end loop;

  if v_errors <> '{}'::jsonb then
    -- Il link NON viene consumato: la transazione termina senza modifiche.
    return jsonb_build_object('status', 'errors', 'errors', v_errors);
  end if;

  -- Consumo del link e salvataggio: atomici (stessa transazione della funzione).
  delete from public.tokens where token_hash = v_hash;
  insert into public.responses (questionnaire_id) values (v_qid) returning id into v_rid;
  insert into public.answers_text (response_id, question_id, value)
    select v_rid, (e->>'q')::bigint, e->>'v' from jsonb_array_elements(v_texts) e;
  insert into public.answers_choice (response_id, question_id, option_id)
    select v_rid, (e->>'q')::bigint, (e->>'o')::bigint from jsonb_array_elements(v_choice) e;

  return jsonb_build_object('status', 'ok');
end $$;

-- ========================================================= amministrazione

create or replace function public.admin_whoami()
returns jsonb language sql stable security definer
set search_path = public, pg_catalog
as $$ select jsonb_build_object('is_admin', public._is_admin()) $$;

create or replace function public.admin_list()
returns jsonb language plpgsql stable security definer
set search_path = public, pg_catalog
as $$
begin
  perform public._require_admin();
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', q.id, 'title', q.title, 'status', q.status, 'created_at', q.created_at,
      'question_count', (select count(*) from public.questions  where questionnaire_id = q.id),
      'token_unused',   (select count(*) from public.tokens     where questionnaire_id = q.id),
      'response_count', (select count(*) from public.responses  where questionnaire_id = q.id)
    ) order by q.id desc)
    from public.questionnaires q), '[]'::jsonb);
end $$;

create or replace function public.admin_get(p_id bigint)
returns jsonb language plpgsql stable security definer
set search_path = public, pg_catalog
as $$
declare v_q public.questionnaires;
begin
  perform public._require_admin();
  select * into v_q from public.questionnaires where id = p_id;
  if not found then raise exception 'Questionario non trovato.' using errcode = 'P0002'; end if;
  return jsonb_build_object(
    'id', v_q.id, 'title', v_q.title, 'description', v_q.description, 'status', v_q.status,
    'questions', public._questions_json(v_q.id),
    'token_unused',   (select count(*) from public.tokens    where questionnaire_id = v_q.id),
    'response_count', (select count(*) from public.responses where questionnaire_id = v_q.id));
end $$;

create or replace function public._validate_meta(p_title text, p_description text)
returns void language plpgsql stable
set search_path = pg_catalog
as $$
begin
  if coalesce(btrim(p_title), '') = '' then raise exception 'Il titolo è obbligatorio.' using errcode = '22023'; end if;
  if char_length(btrim(p_title)) > 200 then raise exception 'Il titolo supera 200 caratteri.' using errcode = '22023'; end if;
  if char_length(coalesce(p_description, '')) > 5000 then raise exception 'La descrizione supera 5000 caratteri.' using errcode = '22023'; end if;
end $$;

create or replace function public.admin_create(p_title text, p_description text default '')
returns bigint language plpgsql volatile security definer
set search_path = public, pg_catalog
as $$
declare v_id bigint;
begin
  perform public._require_admin();
  perform public._validate_meta(p_title, p_description);
  insert into public.questionnaires (title, description)
    values (btrim(p_title), btrim(coalesce(p_description, ''))) returning id into v_id;
  return v_id;
end $$;

/** Valida e sostituisce l'intera struttura delle domande. */
create or replace function public._replace_questions(p_id bigint, p_questions jsonb)
returns void language plpgsql volatile security definer
set search_path = public, pg_catalog
as $$
declare
  v_q     jsonb;
  v_n     int := 0;
  v_type  text;
  v_text  text;
  v_opts  text[];
  v_qid   bigint;
begin
  if jsonb_typeof(p_questions) <> 'array' then raise exception 'Elenco domande non valido.' using errcode = '22023'; end if;
  if jsonb_array_length(p_questions) > 200 then raise exception 'Massimo 200 domande.' using errcode = '22023'; end if;
  delete from public.questions where questionnaire_id = p_id;
  for v_q in select * from jsonb_array_elements(p_questions) loop
    v_n := v_n + 1;
    v_type := v_q->>'type';
    if v_type is null or v_type not in ('open','single','multiple') then
      raise exception 'Domanda %: tipo non valido.', v_n using errcode = '22023';
    end if;
    v_text := btrim(coalesce(v_q->>'text', ''));
    if v_text = '' then raise exception 'Domanda %: il testo è obbligatorio.', v_n using errcode = '22023'; end if;
    if char_length(v_text) > 1000 then raise exception 'Domanda %: il testo supera 1000 caratteri.', v_n using errcode = '22023'; end if;
    insert into public.questions (questionnaire_id, position, type, text, required)
      values (p_id, v_n, v_type, v_text, coalesce((v_q->>'required')::boolean, true))
      returning id into v_qid;
    if v_type <> 'open' then
      if jsonb_typeof(v_q->'options') is distinct from 'array' then
        raise exception 'Domanda %: risposte possibili mancanti.', v_n using errcode = '22023';
      end if;
      select coalesce(array_agg(btrim(e #>> '{}') order by ord), '{}') into v_opts
        from jsonb_array_elements(v_q->'options') with ordinality as x(e, ord)
       where jsonb_typeof(e) = 'string' and btrim(e #>> '{}') <> '';
      if cardinality(v_opts) < 2 then raise exception 'Domanda %: servono almeno 2 risposte possibili.', v_n using errcode = '22023'; end if;
      if cardinality(v_opts) > 50 then raise exception 'Domanda %: massimo 50 risposte possibili.', v_n using errcode = '22023'; end if;
      if exists (select 1 from unnest(v_opts) o where char_length(o) > 300) then
        raise exception 'Domanda %: una risposta supera 300 caratteri.', v_n using errcode = '22023';
      end if;
      if (select count(distinct lower(o)) from unnest(v_opts) o) <> cardinality(v_opts) then
        raise exception 'Domanda %: risposte possibili duplicate.', v_n using errcode = '22023';
      end if;
      insert into public.options (question_id, position, text)
        select v_qid, ord, o from unnest(v_opts) with ordinality as u(o, ord);
    end if;
  end loop;
end $$;

/** Aggiorna titolo/descrizione e, se p_questions non è null, le domande. */
create or replace function public.admin_update(p_id bigint, p_title text, p_description text, p_questions jsonb default null)
returns jsonb language plpgsql volatile security definer
set search_path = public, pg_catalog
as $$
declare v_status text;
begin
  perform public._require_admin();
  perform public._validate_meta(p_title, p_description);
  select status into v_status from public.questionnaires where id = p_id for update;
  if not found then raise exception 'Questionario non trovato.' using errcode = 'P0002'; end if;
  if p_questions is not null then
    if exists (select 1 from public.responses where questionnaire_id = p_id) then
      raise exception 'Le domande non sono modificabili perché sono già state raccolte risposte. Duplica il questionario per crearne una nuova versione.' using errcode = '55000';
    end if;
    if v_status = 'open' then
      raise exception 'Sospendi la raccolta (stato "Bozza") prima di modificare le domande.' using errcode = '55000';
    end if;
    perform public._replace_questions(p_id, p_questions);
  end if;
  update public.questionnaires set title = btrim(p_title), description = btrim(coalesce(p_description, '')) where id = p_id;
  return public.admin_get(p_id);
end $$;

create or replace function public.admin_set_status(p_id bigint, p_status text)
returns jsonb language plpgsql volatile security definer
set search_path = public, pg_catalog
as $$
begin
  perform public._require_admin();
  if p_status is null or p_status not in ('draft','open','closed') then
    raise exception 'Stato non valido.' using errcode = '22023';
  end if;
  perform 1 from public.questionnaires where id = p_id for update;
  if not found then raise exception 'Questionario non trovato.' using errcode = 'P0002'; end if;
  if p_status = 'open' and not exists (select 1 from public.questions where questionnaire_id = p_id) then
    raise exception 'Aggiungi almeno una domanda prima di aprire la raccolta.' using errcode = '22023';
  end if;
  update public.questionnaires set status = p_status where id = p_id;
  return public.admin_get(p_id);
end $$;

create or replace function public.admin_duplicate(p_id bigint)
returns bigint language plpgsql volatile security definer
set search_path = public, pg_catalog
as $$
declare v_src public.questionnaires; v_new bigint;
begin
  perform public._require_admin();
  select * into v_src from public.questionnaires where id = p_id;
  if not found then raise exception 'Questionario non trovato.' using errcode = 'P0002'; end if;
  insert into public.questionnaires (title, description)
    values (left(v_src.title || ' (copia)', 200), v_src.description) returning id into v_new;
  perform public._replace_questions(v_new, (
    select coalesce(jsonb_agg(jsonb_build_object(
      'type', e->>'type', 'text', e->>'text', 'required', (e->>'required')::boolean,
      'options', (select coalesce(jsonb_agg(o->'text'), '[]'::jsonb) from jsonb_array_elements(e->'options') o)
    )), '[]'::jsonb)
    from jsonb_array_elements(public._questions_json(p_id)) e));
  return v_new;
end $$;

create or replace function public.admin_delete(p_id bigint)
returns void language plpgsql volatile security definer
set search_path = public, pg_catalog
as $$
begin
  perform public._require_admin();
  delete from public.questionnaires where id = p_id;
end $$;

/** Genera p_count link monouso. I token in chiaro sono restituiti una sola volta. */
create or replace function public.admin_create_tokens(p_id bigint, p_count int)
returns text[] language plpgsql volatile security definer
set search_path = public, pg_catalog
as $$
declare v_tokens text[] := '{}'; v_t text;
begin
  perform public._require_admin();
  if p_count is null or p_count < 1 or p_count > 2000 then
    raise exception 'Indica un numero di link tra 1 e 2000.' using errcode = '22023';
  end if;
  perform 1 from public.questionnaires where id = p_id;
  if not found then raise exception 'Questionario non trovato.' using errcode = 'P0002'; end if;
  for i in 1..p_count loop
    -- UUID v4 da generatore crittografico: 122 bit di entropia (32 caratteri esadecimali)
    v_t := replace(gen_random_uuid()::text, '-', '');
    insert into public.tokens (token_hash, questionnaire_id) values (public._hash_token(v_t), p_id);
    v_tokens := v_tokens || v_t;
  end loop;
  return v_tokens;
end $$;

create or replace function public.admin_revoke_tokens(p_id bigint)
returns int language plpgsql volatile security definer
set search_path = public, pg_catalog
as $$
declare v_n int;
begin
  perform public._require_admin();
  delete from public.tokens where questionnaire_id = p_id;
  get diagnostics v_n = row_count;
  return v_n;
end $$;

/** Risultati aggregati. Le risposte aperte sono in ordine casuale. */
create or replace function public.admin_results(p_id bigint)
returns jsonb language plpgsql stable security definer
set search_path = public, pg_catalog
as $$
begin
  perform public._require_admin();
  perform 1 from public.questionnaires where id = p_id;
  if not found then raise exception 'Questionario non trovato.' using errcode = 'P0002'; end if;
  return jsonb_build_object(
    'total', (select count(*) from public.responses where questionnaire_id = p_id),
    'questions', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', q.id, 'type', q.type, 'text', q.text,
        'answered', case when q.type = 'open'
          then (select count(*) from public.answers_text a where a.question_id = q.id)
          else (select count(distinct a.response_id) from public.answers_choice a where a.question_id = q.id) end,
        'answers', case when q.type = 'open'
          then coalesce((select jsonb_agg(a.value order by random()) from public.answers_text a where a.question_id = q.id), '[]'::jsonb)
          else null end,
        'options', coalesce((
          select jsonb_agg(jsonb_build_object('id', o.id, 'text', o.text,
                   'count', (select count(*) from public.answers_choice a where a.option_id = o.id))
                 order by o.position, o.id)
          from public.options o where o.question_id = q.id), '[]'::jsonb)
      ) order by q.position, q.id)
      from public.questions q where q.questionnaire_id = p_id), '[]'::jsonb));
end $$;

/** Dati per l'export CSV: una riga per risposta, in ordine casuale. */
create or replace function public.admin_export(p_id bigint)
returns jsonb language plpgsql stable security definer
set search_path = public, pg_catalog
as $$
begin
  perform public._require_admin();
  perform 1 from public.questionnaires where id = p_id;
  if not found then raise exception 'Questionario non trovato.' using errcode = 'P0002'; end if;
  return jsonb_build_object(
    'headers', coalesce((select jsonb_agg(q.text order by q.position, q.id) from public.questions q where q.questionnaire_id = p_id), '[]'::jsonb),
    'rows', coalesce((
      select jsonb_agg(row_data order by random())
      from (
        select (
          select jsonb_agg(
            case when q.type = 'open'
              then coalesce((select a.value from public.answers_text a where a.response_id = r.id and a.question_id = q.id), '')
              else coalesce((select string_agg(o.text, '; ' order by o.position)
                               from public.answers_choice a join public.options o on o.id = a.option_id
                              where a.response_id = r.id and a.question_id = q.id), '')
            end order by q.position, q.id)
          from public.questions q where q.questionnaire_id = p_id
        ) as row_data
        from public.responses r where r.questionnaire_id = p_id
      ) s), '[]'::jsonb));
end $$;

-- ------------------------------------------------ esecuzione delle funzioni
-- Di default PostgreSQL concede EXECUTE a PUBLIC: lo si revoca e si concede
-- solo quanto necessario.
do $$
declare f record;
begin
  for f in
    select p.oid::regprocedure as sig, p.proname
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and (p.proname like '\_%' or p.proname like 'admin\_%' or p.proname in ('get_survey','submit_response'))
  loop
    execute format('revoke all on function %s from public, anon, authenticated', f.sig);
    if f.proname in ('get_survey', 'submit_response') then
      execute format('grant execute on function %s to anon, authenticated', f.sig);
    elsif f.proname like 'admin\_%' then
      execute format('grant execute on function %s to authenticated', f.sig);
    end if;
  end loop;
end $$;
