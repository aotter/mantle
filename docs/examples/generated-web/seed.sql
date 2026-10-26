-- Local fixture only. Production publishing goes through the generated Procedures.
-- Every system column is set: timestamps are microseconds since the Unix epoch (2026-01-01T00:00:00Z); 0 would show as 1970.
INSERT INTO posts (id, version, created_at, updated_at, title, body, status, published_at) VALUES
('home', 1, 1767225600000000, 1767225600000000, 'Posts', '# Posts — browse the HTML index for articles.', 'published', 1767225600000000),
('hello', 1, 1767225600000000, 1767225600000000, 'Hello <world>', '# Hello world', 'published', 1767225600000000),
('second', 1, 1767225600000000, 1767225600000000, 'Second post', '# Second post', 'published', 1767225600000000),
('draft', 1, 1767225600000000, 1767225600000000, 'Hidden draft', '# Draft', 'draft', NULL);
