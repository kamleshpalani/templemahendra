<?php

function publicContentIsHidden(array $item): bool
{
    foreach ($item as $value) {
        if (is_array($value) && publicContentIsHidden($value)) {
            return true;
        }
        if (is_string($value) && preg_match('/new[\s-]+moon|amavas(?:ai|ya|yai)?|அமாவாச/iu', $value)) {
            return true;
        }
    }
    return false;
}

function publicContentVisible(array $items): array
{
    return array_values(array_filter($items, fn(array $item) => !publicContentIsHidden($item)));
}
