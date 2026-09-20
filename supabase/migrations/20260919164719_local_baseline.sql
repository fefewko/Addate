--
-- PostgreSQL database dump
--

\restrict SlpYOsPjuiIO9cVtbPE2j0xQz89diAC8zFzXLRcGsh5YFfD9Ohg8x5K038uy2GU

-- Dumped from database version 17.6
-- Dumped by pg_dump version 17.6

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--


--
-- Name: SCHEMA public; Type: COMMENT; Schema: -; Owner: -
--



--
-- Name: handle_new_user(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.handle_new_user() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
begin
  insert into public.profiles (
    id,
    moderation_status,
    created_at,
    updated_at
  )
  values (
    new.id,
    'pending',
    now(),
    now()
  );
  return new;
end;
$$;


--
-- Name: nearby_profiles(double precision, double precision); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.nearby_profiles(viewer_lat double precision, viewer_lng double precision) RETURNS TABLE(profile_id uuid, distance_km double precision)
    LANGUAGE sql STABLE
    AS $$
  select p.id as profile_id,
         (point(p.longitude, p.latitude) <@> point(viewer_lng, viewer_lat)) * 1.60934 as distance_km
  from profiles p
  where p.moderation_status = 'approved'
    and p.latitude is not null
    and p.longitude is not null;
$$;


--
-- Name: prevent_admin_block(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.prevent_admin_block() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  if exists (select 1 from profiles where id = new.blocked_id and is_admin = true) then
    raise exception 'Нельзя заблокировать поддержку' using errcode = 'P0001';
  end if;
  return new;
end;
$$;


--
-- Name: touch_support_ticket(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.touch_support_ticket() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  update public.support_tickets
     set last_message_at = new.created_at,
         updated_at = now()
   where id = new.ticket_id;
  return new;
end;
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: blocks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.blocks (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    blocker_id uuid NOT NULL,
    blocked_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: matches; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.matches (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_a uuid NOT NULL,
    user_b uuid NOT NULL,
    status text DEFAULT 'pending'::text,
    created_at timestamp with time zone DEFAULT now(),
    matched_at timestamp with time zone,
    CONSTRAINT matches_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'matched'::text, 'rejected'::text])))
);


--
-- Name: messages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.messages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    match_id uuid NOT NULL,
    sender_id uuid NOT NULL,
    content text,
    created_at timestamp with time zone DEFAULT now(),
    read_at timestamp with time zone,
    image_path text,
    CONSTRAINT messages_content_or_image CHECK ((((content IS NOT NULL) AND (length(TRIM(BOTH FROM content)) > 0)) OR (image_path IS NOT NULL)))
);


--
-- Name: profiles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.profiles (
    id uuid NOT NULL,
    display_name text,
    birth_date date,
    gender text,
    looking_for text,
    city text,
    bio text,
    sobriety_status text DEFAULT 'ne_ukazano'::text,
    sobriety_since date,
    substance_type text[],
    photo_url text,
    moderation_status text DEFAULT '''approved''::text'::text,
    moderation_note text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    height_cm integer,
    weight_kg integer,
    additional_photos text[],
    latitude double precision,
    longitude double precision,
    last_seen_at timestamp with time zone,
    is_admin boolean DEFAULT false,
    CONSTRAINT profiles_moderation_status_check CHECK ((moderation_status = ANY (ARRAY['pending'::text, 'approved'::text, 'rejected'::text]))),
    CONSTRAINT profiles_sobriety_status_check CHECK ((sobriety_status = ANY (ARRAY['trezv'::text, 'v_sryve'::text, 'ne_ukazano'::text])))
);


--
-- Name: push_tokens; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.push_tokens (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    expo_push_token text NOT NULL,
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: report_attachments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.report_attachments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    report_id uuid NOT NULL,
    storage_path text NOT NULL,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: reports; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.reports (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    reporter_id uuid NOT NULL,
    reported_id uuid NOT NULL,
    category text NOT NULL,
    description text,
    status text DEFAULT 'open'::text,
    created_at timestamp with time zone DEFAULT now(),
    reviewed_at timestamp with time zone,
    CONSTRAINT reports_category_check CHECK ((category = ANY (ARRAY['harassment'::text, 'spam_or_ads'::text, 'fake_profile'::text, 'scam'::text, 'other'::text]))),
    CONSTRAINT reports_status_check CHECK ((status = ANY (ARRAY['open'::text, 'reviewed'::text, 'dismissed'::text, 'action_taken'::text])))
);


--
-- Name: support_messages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.support_messages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    ticket_id uuid NOT NULL,
    sender_id uuid NOT NULL,
    content text,
    image_path text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    read_at timestamp with time zone
);


--
-- Name: support_tickets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.support_tickets (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid,
    message text NOT NULL,
    response text,
    status text DEFAULT 'open'::text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    admin_id uuid,
    last_message_at timestamp with time zone,
    closed_at timestamp with time zone
);


--
-- Name: telegram_identities; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.telegram_identities (
    telegram_id bigint NOT NULL,
    user_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: telegram_login_tokens; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.telegram_login_tokens (
    token uuid DEFAULT gen_random_uuid() NOT NULL,
    status text DEFAULT 'pending'::text,
    telegram_id bigint,
    telegram_username text,
    telegram_first_name text,
    created_at timestamp with time zone DEFAULT now(),
    expires_at timestamp with time zone DEFAULT (now() + '00:05:00'::interval),
    CONSTRAINT telegram_login_tokens_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'confirmed'::text, 'used'::text])))
);


--
-- Name: blocks blocks_blocker_id_blocked_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.blocks
    ADD CONSTRAINT blocks_blocker_id_blocked_id_key UNIQUE (blocker_id, blocked_id);


--
-- Name: blocks blocks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.blocks
    ADD CONSTRAINT blocks_pkey PRIMARY KEY (id);


--
-- Name: matches matches_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.matches
    ADD CONSTRAINT matches_pkey PRIMARY KEY (id);


--
-- Name: matches matches_user_a_user_b_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.matches
    ADD CONSTRAINT matches_user_a_user_b_key UNIQUE (user_a, user_b);


--
-- Name: messages messages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.messages
    ADD CONSTRAINT messages_pkey PRIMARY KEY (id);


--
-- Name: profiles profiles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.profiles
    ADD CONSTRAINT profiles_pkey PRIMARY KEY (id);


--
-- Name: push_tokens push_tokens_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.push_tokens
    ADD CONSTRAINT push_tokens_pkey PRIMARY KEY (id);


--
-- Name: push_tokens push_tokens_user_id_expo_push_token_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.push_tokens
    ADD CONSTRAINT push_tokens_user_id_expo_push_token_key UNIQUE (user_id, expo_push_token);


--
-- Name: report_attachments report_attachments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.report_attachments
    ADD CONSTRAINT report_attachments_pkey PRIMARY KEY (id);


--
-- Name: reports reports_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reports
    ADD CONSTRAINT reports_pkey PRIMARY KEY (id);


--
-- Name: support_messages support_messages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.support_messages
    ADD CONSTRAINT support_messages_pkey PRIMARY KEY (id);


--
-- Name: support_tickets support_tickets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.support_tickets
    ADD CONSTRAINT support_tickets_pkey PRIMARY KEY (id);


--
-- Name: telegram_identities telegram_identities_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.telegram_identities
    ADD CONSTRAINT telegram_identities_pkey PRIMARY KEY (telegram_id);


--
-- Name: telegram_login_tokens telegram_login_tokens_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.telegram_login_tokens
    ADD CONSTRAINT telegram_login_tokens_pkey PRIMARY KEY (token);


--
-- Name: idx_matches_user_a; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_matches_user_a ON public.matches USING btree (user_a);


--
-- Name: idx_matches_user_b; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_matches_user_b ON public.matches USING btree (user_b);


--
-- Name: idx_messages_match_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_messages_match_id ON public.messages USING btree (match_id);


--
-- Name: idx_profiles_city; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_profiles_city ON public.profiles USING btree (city);


--
-- Name: idx_profiles_moderation_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_profiles_moderation_status ON public.profiles USING btree (moderation_status);


--
-- Name: idx_reports_reported_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_reports_reported_id ON public.reports USING btree (reported_id);


--
-- Name: idx_reports_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_reports_status ON public.reports USING btree (status);


--
-- Name: matches_unique_pair; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX matches_unique_pair ON public.matches USING btree (LEAST(user_a, user_b), GREATEST(user_a, user_b));


--
-- Name: support_messages_ticket_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX support_messages_ticket_created_idx ON public.support_messages USING btree (ticket_id, created_at);


--
-- Name: support_tickets_last_message_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX support_tickets_last_message_at_idx ON public.support_tickets USING btree (last_message_at DESC);


--
-- Name: support_tickets_user_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX support_tickets_user_id_idx ON public.support_tickets USING btree (user_id);


--
-- Name: blocks no_blocking_admin; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER no_blocking_admin BEFORE INSERT ON public.blocks FOR EACH ROW EXECUTE FUNCTION public.prevent_admin_block();


--
-- Name: support_messages support_messages_touch_ticket; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER support_messages_touch_ticket AFTER INSERT ON public.support_messages FOR EACH ROW EXECUTE FUNCTION public.touch_support_ticket();


--
-- Name: blocks blocks_blocked_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.blocks
    ADD CONSTRAINT blocks_blocked_id_fkey FOREIGN KEY (blocked_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: blocks blocks_blocker_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.blocks
    ADD CONSTRAINT blocks_blocker_id_fkey FOREIGN KEY (blocker_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: matches matches_user_a_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.matches
    ADD CONSTRAINT matches_user_a_fkey FOREIGN KEY (user_a) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: matches matches_user_b_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.matches
    ADD CONSTRAINT matches_user_b_fkey FOREIGN KEY (user_b) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: messages messages_match_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.messages
    ADD CONSTRAINT messages_match_id_fkey FOREIGN KEY (match_id) REFERENCES public.matches(id) ON DELETE CASCADE;


--
-- Name: messages messages_sender_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.messages
    ADD CONSTRAINT messages_sender_id_fkey FOREIGN KEY (sender_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: profiles profiles_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.profiles
    ADD CONSTRAINT profiles_id_fkey FOREIGN KEY (id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: push_tokens push_tokens_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.push_tokens
    ADD CONSTRAINT push_tokens_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: report_attachments report_attachments_report_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.report_attachments
    ADD CONSTRAINT report_attachments_report_id_fkey FOREIGN KEY (report_id) REFERENCES public.reports(id) ON DELETE CASCADE;


--
-- Name: reports reports_reported_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reports
    ADD CONSTRAINT reports_reported_id_fkey FOREIGN KEY (reported_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: reports reports_reporter_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reports
    ADD CONSTRAINT reports_reporter_id_fkey FOREIGN KEY (reporter_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: support_messages support_messages_sender_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.support_messages
    ADD CONSTRAINT support_messages_sender_id_fkey FOREIGN KEY (sender_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: support_messages support_messages_ticket_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.support_messages
    ADD CONSTRAINT support_messages_ticket_id_fkey FOREIGN KEY (ticket_id) REFERENCES public.support_tickets(id) ON DELETE CASCADE;


--
-- Name: support_tickets support_tickets_admin_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.support_tickets
    ADD CONSTRAINT support_tickets_admin_id_fkey FOREIGN KEY (admin_id) REFERENCES auth.users(id);


--
-- Name: support_tickets support_tickets_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.support_tickets
    ADD CONSTRAINT support_tickets_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: telegram_identities telegram_identities_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.telegram_identities
    ADD CONSTRAINT telegram_identities_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: support_messages Allow insert access to ticket owner or admin; Type: POLICY; Schema: public; Owner: -
--

-- Admin helper (must exist before policies)
CREATE SCHEMA IF NOT EXISTS private;
CREATE OR REPLACE FUNCTION private.is_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO '';
AS $$
  select exists (
    select 1
    from public.profiles p
    where p.id = (select auth.uid())
      and p.is_admin = true
  );
$$;

-- Admin helper (must exist before policies)
CREATE SCHEMA IF NOT EXISTS private;
CREATE OR REPLACE FUNCTION private.is_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO '';
AS $$
  select exists (
    select 1
    from public.profiles p
    where p.id = (select auth.uid())
      and p.is_admin = true
  );
$$;

CREATE POLICY "Allow insert access to ticket owner or admin" ON public.support_messages FOR INSERT TO authenticated WITH CHECK ((EXISTS ( SELECT 1
   FROM (public.support_tickets st
     LEFT JOIN public.profiles p ON ((p.id = auth.uid())))
  WHERE ((st.id = support_messages.ticket_id) AND ((st.user_id = auth.uid()) OR (p.is_admin = true))))));


--
-- Name: support_messages Allow read access to ticket owner or admin; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Allow read access to ticket owner or admin" ON public.support_messages FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM (public.support_tickets st
     LEFT JOIN public.profiles p ON ((p.id = auth.uid())))
  WHERE ((st.id = support_messages.ticket_id) AND ((st.user_id = auth.uid()) OR (p.is_admin = true))))));


--
-- Name: support_messages Service role full access; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Service role full access" ON public.support_messages TO service_role USING (true) WITH CHECK (true);


--
-- Name: reports Users can create reports; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can create reports" ON public.reports FOR INSERT TO authenticated WITH CHECK ((auth.uid() = reporter_id));


--
-- Name: blocks; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.blocks ENABLE ROW LEVEL SECURITY;

--
-- Name: matches; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.matches ENABLE ROW LEVEL SECURITY;

--
-- Name: messages; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;

--
-- Name: profiles; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

--
-- Name: push_tokens; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.push_tokens ENABLE ROW LEVEL SECURITY;

--
-- Name: report_attachments; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.report_attachments ENABLE ROW LEVEL SECURITY;

--
-- Name: reports; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.reports ENABLE ROW LEVEL SECURITY;

--
-- Name: support_messages; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.support_messages ENABLE ROW LEVEL SECURITY;

--
-- Name: support_tickets; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.support_tickets ENABLE ROW LEVEL SECURITY;

--
-- Name: telegram_identities; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.telegram_identities ENABLE ROW LEVEL SECURITY;

--
-- Name: telegram_login_tokens; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.telegram_login_tokens ENABLE ROW LEVEL SECURITY;

--
-- Name: profiles Админ видит все анкеты; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Админ видит все анкеты" ON public.profiles FOR SELECT TO authenticated USING (( SELECT private.is_admin() AS is_admin));


--
-- Name: reports Админ видит все жалобы; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Админ видит все жалобы" ON public.reports FOR SELECT USING ((EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.is_admin = true)))));


--
-- Name: support_tickets Админ видит обращения; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Админ видит обращения" ON public.support_tickets FOR SELECT TO authenticated USING (( SELECT private.is_admin() AS is_admin));


--
-- Name: support_messages Админ видит сообщения поддержки; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Админ видит сообщения поддержки" ON public.support_messages FOR SELECT TO authenticated USING (( SELECT private.is_admin() AS is_admin));


--
-- Name: reports Админ обновляет жалобы; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Админ обновляет жалобы" ON public.reports FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.is_admin = true)))));


--
-- Name: support_tickets Админ обновляет обращения; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Админ обновляет обращения" ON public.support_tickets FOR UPDATE TO authenticated USING (( SELECT private.is_admin() AS is_admin)) WITH CHECK (( SELECT private.is_admin() AS is_admin));


--
-- Name: support_messages Админ обновляет сообщения поддерж; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Админ обновляет сообщения поддерж" ON public.support_messages FOR UPDATE TO authenticated USING (( SELECT private.is_admin() AS is_admin)) WITH CHECK (( SELECT private.is_admin() AS is_admin));


--
-- Name: support_messages Админ отправляет сообщения поддер; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Админ отправляет сообщения поддер" ON public.support_messages FOR INSERT TO authenticated WITH CHECK ((( SELECT private.is_admin() AS is_admin) AND (sender_id = ( SELECT auth.uid() AS uid))));


--
-- Name: profiles Админ редактирует любую анкету; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Админ редактирует любую анкету" ON public.profiles FOR UPDATE TO authenticated USING (( SELECT private.is_admin() AS is_admin)) WITH CHECK (( SELECT private.is_admin() AS is_admin));


--
-- Name: matches Обновление статуса своего совпаде; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Обновление статуса своего совпаде" ON public.matches FOR UPDATE USING (((auth.uid() = user_a) OR (auth.uid() = user_b)));


--
-- Name: messages Отметка сообщений прочитанными; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Отметка сообщений прочитанными" ON public.messages FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM public.matches m
  WHERE ((m.id = messages.match_id) AND ((auth.uid() = m.user_a) OR (auth.uid() = m.user_b))))));


--
-- Name: messages Отправка сообщений в своём совпад; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Отправка сообщений в своём совпад" ON public.messages FOR INSERT WITH CHECK (((sender_id = auth.uid()) AND (EXISTS ( SELECT 1
   FROM public.matches m
  WHERE ((m.id = messages.match_id) AND (m.status = 'matched'::text) AND ((auth.uid() = m.user_a) OR (auth.uid() = m.user_b))))) AND (NOT (EXISTS ( SELECT 1
   FROM (public.matches m
     JOIN public.blocks b ON ((((b.blocker_id = m.user_a) AND (b.blocked_id = m.user_b)) OR ((b.blocker_id = m.user_b) AND (b.blocked_id = m.user_a)))))
  WHERE (m.id = messages.match_id))))));


--
-- Name: reports Подать жалобу; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Подать жалобу" ON public.reports FOR INSERT WITH CHECK ((reporter_id = auth.uid()));


--
-- Name: reports Пользователи могут создавать жало; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Пользователи могут создавать жало" ON public.reports FOR INSERT TO authenticated WITH CHECK ((auth.uid() = reporter_id));


--
-- Name: report_attachments Пользователь видит вложения своих; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Пользователь видит вложения своих" ON public.report_attachments FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.reports r
  WHERE ((r.id = report_attachments.report_id) AND (r.reporter_id = auth.uid())))));


--
-- Name: support_tickets Пользователь видит свои обращения; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Пользователь видит свои обращения" ON public.support_tickets FOR SELECT TO authenticated USING ((user_id = auth.uid()));


--
-- Name: support_messages Пользователь видит сообщения подд; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Пользователь видит сообщения подд" ON public.support_messages FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.support_tickets t
  WHERE ((t.id = support_messages.ticket_id) AND (t.user_id = auth.uid())))));


--
-- Name: report_attachments Пользователь добавляет вложения с; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Пользователь добавляет вложения с" ON public.report_attachments FOR INSERT TO authenticated WITH CHECK ((EXISTS ( SELECT 1
   FROM public.reports r
  WHERE ((r.id = report_attachments.report_id) AND (r.reporter_id = auth.uid())))));


--
-- Name: support_tickets Пользователь обновляет своё обращ; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Пользователь обновляет своё обращ" ON public.support_tickets FOR UPDATE TO authenticated USING ((user_id = auth.uid())) WITH CHECK ((user_id = auth.uid()));


--
-- Name: support_messages Пользователь обновляет сообщения; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Пользователь обновляет сообщения" ON public.support_messages FOR UPDATE TO authenticated USING ((sender_id = auth.uid())) WITH CHECK ((sender_id = auth.uid()));


--
-- Name: support_messages Пользователь отправляет сообщени; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Пользователь отправляет сообщени" ON public.support_messages FOR INSERT TO authenticated WITH CHECK (((sender_id = auth.uid()) AND (EXISTS ( SELECT 1
   FROM public.support_tickets t
  WHERE ((t.id = support_messages.ticket_id) AND (t.user_id = auth.uid()) AND (COALESCE(t.status, 'open'::text) <> 'closed'::text))))));


--
-- Name: support_tickets Пользователь создаёт обращение; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Пользователь создаёт обращение" ON public.support_tickets FOR INSERT TO authenticated WITH CHECK ((user_id = auth.uid()));


--
-- Name: reports Просмотр жалоб; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Просмотр жалоб" ON public.reports FOR SELECT TO authenticated USING (((auth.uid() = reporter_id) OR (auth.uid() = reported_id)));


--
-- Name: profiles Просмотр одобренных анкет; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Просмотр одобренных анкет" ON public.profiles FOR SELECT USING (((moderation_status = 'approved'::text) OR (id = auth.uid())));


--
-- Name: profiles Редактирование своей анкеты; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Редактирование своей анкеты" ON public.profiles FOR UPDATE USING ((id = auth.uid()));


--
-- Name: blocks Свои блокировки; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Свои блокировки" ON public.blocks USING ((blocker_id = auth.uid()));


--
-- Name: matches Свои совпадения; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Свои совпадения" ON public.matches FOR SELECT USING (((auth.uid() = user_a) OR (auth.uid() = user_b)));


--
-- Name: matches Создание лайка от своего имени; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Создание лайка от своего имени" ON public.matches FOR INSERT WITH CHECK ((auth.uid() = user_a));


--
-- Name: profiles Создание своей анкеты; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Создание своей анкеты" ON public.profiles FOR INSERT WITH CHECK ((id = auth.uid()));


--
-- Name: messages Сообщения своего совпадения; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Сообщения своего совпадения" ON public.messages FOR SELECT USING ((EXISTS ( SELECT 1
   FROM public.matches m
  WHERE ((m.id = messages.match_id) AND ((auth.uid() = m.user_a) OR (auth.uid() = m.user_b))))));


--
-- Name: profiles Удаление своей анкеты; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Удаление своей анкеты" ON public.profiles FOR DELETE USING ((id = auth.uid()));


--
-- Name: push_tokens Управление своими push-токенами; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Управление своими push-токенами" ON public.push_tokens USING ((user_id = auth.uid())) WITH CHECK ((user_id = auth.uid()));


--
-- PostgreSQL database dump complete
--

\unrestrict SlpYOsPjuiIO9cVtbPE2j0xQz89diAC8zFzXLRcGsh5YFfD9Ohg8x5K038uy2GU

CREATE POLICY 'Загрузка своего аватара' ON storage.objects FOR INSERT TO public WITH CHECK (((bucket_id = 'avatars'::text) AND ((storage.foldername(name))[1] = (auth.uid())::text)));
CREATE POLICY 'Загрузка фото в свой чат' ON storage.objects FOR INSERT TO public WITH CHECK (((bucket_id = 'chat-images'::text) AND (EXISTS ( SELECT 1
   FROM matches
  WHERE (((matches.id)::text = (storage.foldername(objects.name))[1]) AND (matches.status = 'matched'::text) AND ((matches.user_a = auth.uid()) OR (matches.user_b = auth.uid())))))));
CREATE POLICY 'Загрузка фото жалобы' ON storage.objects FOR INSERT TO authenticated WITH CHECK (((bucket_id = 'report-images'::text) AND ((storage.foldername(name))[1] = (auth.uid())::text)));
CREATE POLICY 'Обновление своего аватара' ON storage.objects FOR UPDATE TO public USING (((bucket_id = 'avatars'::text) AND ((storage.foldername(name))[1] = (auth.uid())::text)));
CREATE POLICY 'Пользователи могут видеть фото жа' ON storage.objects FOR SELECT TO authenticated USING ((bucket_id = 'report-images'::text));
CREATE POLICY 'Пользователи могут загружать фото' ON storage.objects FOR INSERT TO authenticated WITH CHECK (((bucket_id = 'report-images'::text) AND ((auth.uid())::text = (owner)::text)));
CREATE POLICY 'Просмотр фото своего чата' ON storage.objects FOR SELECT TO public USING (((bucket_id = 'chat-images'::text) AND (EXISTS ( SELECT 1
   FROM matches
  WHERE (((matches.id)::text = (storage.foldername(objects.name))[1]) AND ((matches.user_a = auth.uid()) OR (matches.user_b = auth.uid())))))));
CREATE POLICY 'Просмотр фото своей жалобы' ON storage.objects FOR SELECT TO authenticated USING (((bucket_id = 'report-images'::text) AND (((storage.foldername(name))[1] = (auth.uid())::text) OR (EXISTS ( SELECT 1
   FROM (reports r
     JOIN report_attachments a ON ((a.report_id = r.id)))
  WHERE ((a.storage_path = objects.name) AND (r.reporter_id = auth.uid())))) OR ( SELECT private.is_admin() AS is_admin))));
CREATE POLICY 'Публичное чтение аватаров' ON storage.objects FOR SELECT TO public USING ((bucket_id = 'avatars'::text));
 
-- Storage buckets 
INSERT INTO storage.buckets (id, name, public) VALUES ('avatars', 'avatars', true) ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, public = EXCLUDED.public; 
INSERT INTO storage.buckets (id, name, public) VALUES ('chat-images', 'chat-images', false) ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, public = EXCLUDED.public; 
INSERT INTO storage.buckets (id, name, public) VALUES ('report-images', 'report-images', false) ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, public = EXCLUDED.public;
 
-- Required extensions 
CREATE EXTENSION IF NOT EXISTS pgcrypto; 
CREATE EXTENSION IF NOT EXISTS cube; 
CREATE EXTENSION IF NOT EXISTS earthdistance; 
 
-- Admin helper 
CREATE SCHEMA IF NOT EXISTS private; 
CREATE OR REPLACE FUNCTION private.is_admin() 
RETURNS boolean 
LANGUAGE sql 
STABLE 
SECURITY DEFINER 
SET search_path TO ''; 
AS $ 
  select exists ( 
    select  
    from public.profiles p 
    where p.id = (select auth.uid()) 
      and p.is_admin = true 
  ); 
$;


-- Realtime publication
ALTER PUBLICATION supabase_realtime ADD TABLE public.matches, public.messages, public.profiles, public.support_messages, public.support_tickets;
