-- Local fixture only. Production publishing goes through the generated Procedures.
INSERT INTO posts (id, version, created_at, updated_at, title, body, status, published_at) VALUES
('home', 1, 0, 0, 'Posts', '# Posts — browse the HTML index for articles.', 'published', 0),
('hello', 1, 0, 0, 'Hello <world>', '# Hello world', 'published', 0),
('second', 1, 0, 0, 'Second post', '# Second post', 'published', 0),
('draft', 1, 0, 0, 'Hidden draft', '# Draft', 'draft', NULL);
