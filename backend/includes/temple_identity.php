<?php
function templeIdentity(): array
{
    static $identity = null;
    return $identity ??= json_decode(file_get_contents(__DIR__ . '/../config/temple_identity.json'), true, 512, JSON_THROW_ON_ERROR);
}
