<?php
require_once __DIR__ . '/../includes/auth.php';
adminLogout();
header('Location: /admin/login.php');
exit;
