UPDATE sevas
SET sort_order = CASE name_en
  WHEN 'Abhishekam' THEN 1
  WHEN 'Pournami Pooja Annadhanam' THEN 2
  WHEN 'Vahana Pooja' THEN 3
  WHEN 'Normal Annadhanam' THEN 4
  WHEN 'Archana with Prasadam' THEN 5
  WHEN 'Archana with Pooja' THEN 6
END
WHERE name_en IN (
  'Abhishekam',
  'Pournami Pooja Annadhanam',
  'Vahana Pooja',
  'Normal Annadhanam',
  'Archana with Prasadam',
  'Archana with Pooja'
);
