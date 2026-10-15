-- ============================================================================
-- LifeBoard · 云同步所需的数据库结构
-- ============================================================================
-- 用法：Supabase 控制台 → 左侧 SQL Editor → 新建查询 → 整段粘贴 → Run
-- 可以重复执行，不会因为已存在而报错。
--
-- 设计说明
--   · 所有 store（榜单 / 档位 / 卡片 / 任务 / 常用任务 / 图片元数据）共用一张
--     sync_records 表：用 store 字段区分。好处是以后加新类型不用改表结构。
--   · 记录本体放 jsonb，因为各 store 的字段完全不同。
--   · sync_tombstones 存"删除记录"。没有它，在手机上删掉的东西会被电脑上的
--     旧数据复活——这是同步最容易踩的坑。
--   · updated_at / deleted_at 用 bigint 存毫秒时间戳，和前端保持一致。
--
-- 安全
--   两张表都开了行级安全（RLS），策略是"只能碰 user_id = 自己"的行。
--   所以网页里放 Publishable key 是安全的；绝对不要放 Service Role Key。
-- ============================================================================


-- ---------------------------------------------------------------------------
-- 1. 记录表
-- ---------------------------------------------------------------------------
create table if not exists public.sync_records (
  user_id    uuid   not null references auth.users (id) on delete cascade,
  store      text   not null,
  id         text   not null,
  updated_at bigint not null,
  data       jsonb  not null,
  primary key (user_id, store, id)
);

-- ---------------------------------------------------------------------------
-- 2. 删除记录（墓碑）
-- ---------------------------------------------------------------------------
create table if not exists public.sync_tombstones (
  user_id    uuid   not null references auth.users (id) on delete cascade,
  store      text   not null,
  record_id  text   not null,
  deleted_at bigint not null,
  primary key (user_id, store, record_id)
);

-- ---------------------------------------------------------------------------
-- 3. 打开行级安全
-- ---------------------------------------------------------------------------
alter table public.sync_records    enable row level security;
alter table public.sync_tombstones enable row level security;

-- ---------------------------------------------------------------------------
-- 4. 策略：每个用户只能读写自己的数据
--    auth.uid() 包在 (select ...) 里，让 Postgres 把它当常量、只算一次，
--    大表上比逐行调用函数快很多。
-- ---------------------------------------------------------------------------
drop policy if exists "own sync records" on public.sync_records;
create policy "own sync records" on public.sync_records
  for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists "own sync tombstones" on public.sync_tombstones;
create policy "own sync tombstones" on public.sync_tombstones
  for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

-- ---------------------------------------------------------------------------
-- 5. 索引：查询总是带 user_id 条件
-- ---------------------------------------------------------------------------
create index if not exists sync_records_user_idx    on public.sync_records (user_id);
create index if not exists sync_tombstones_user_idx on public.sync_tombstones (user_id);


-- ============================================================================
-- 6. 图片本体：Storage 桶 + 策略
-- ============================================================================
-- 图片不塞进数据库（会把库撑爆、查询也慢），走对象存储。
-- 路径格式：lifeboard-images/{用户id}/{图片id}
-- 策略用 (storage.foldername(name))[1] 取路径第一段，必须是自己的 id。
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('lifeboard-images', 'lifeboard-images', false)
on conflict (id) do nothing;

drop policy if exists "own images select" on storage.objects;
create policy "own images select" on storage.objects
  for select to authenticated
  using (bucket_id = 'lifeboard-images' and (storage.foldername(name))[1] = (select auth.uid())::text);

drop policy if exists "own images insert" on storage.objects;
create policy "own images insert" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'lifeboard-images' and (storage.foldername(name))[1] = (select auth.uid())::text);

drop policy if exists "own images update" on storage.objects;
create policy "own images update" on storage.objects
  for update to authenticated
  using (bucket_id = 'lifeboard-images' and (storage.foldername(name))[1] = (select auth.uid())::text);

drop policy if exists "own images delete" on storage.objects;
create policy "own images delete" on storage.objects
  for delete to authenticated
  using (bucket_id = 'lifeboard-images' and (storage.foldername(name))[1] = (select auth.uid())::text);


-- ============================================================================
-- 执行完检查一下
-- ============================================================================
-- 这两句会返回表名；能看到两张表就说明建好了。
select tablename from pg_tables where schemaname = 'public' and tablename like 'sync_%';
select id, public from storage.buckets where id = 'lifeboard-images';
