<#
.SYNOPSIS
    One-time TokScript OAuth setup for the Social Media Ingestion MCP function.

.DESCRIPTION
    TokScript rejects supabase.co redirect URIs during dynamic client registration.
    This script does the OAuth flow locally through localhost, then POSTs the
    resulting TokScript tokens to your deployed Social Media Ingestion function
    via the ?action=init_tokens endpoint.

    Run this once after deploying the function and applying schema.sql. Tokens
    are stored in social_media_provider_tokens with provider_id = tokscript and
    auto-refreshed by the function thereafter.

.PARAMETER MCP_ACCESS_KEY
    Your MCP_ACCESS_KEY secret.

.PARAMETER FunctionUrl
    Base URL of your deployed social-media-ingestion-mcp function.

.PARAMETER Port
    Local port to listen on for the OAuth callback. Default: 8888.

.EXAMPLE
    .\bootstrap-oauth.ps1 -MCP_ACCESS_KEY "<YOUR_MCP_ACCESS_KEY>" -FunctionUrl "https://<PROJECT_REF>.supabase.co/functions/v1/social-media-ingestion-mcp"
#>
param(
    [Parameter(Mandatory = $true)]
    [string]$MCP_ACCESS_KEY,

    [Parameter(Mandatory = $true)]
    [string]$FunctionUrl,

    [Parameter(Mandatory = $false)]
    [int]$Port = 8888
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Web

$redirectUri  = "http://localhost:$Port/callback"
$registerUrl  = "https://api.tokscript.com/api/connector/oauth/register"
$authorizeUrl = "https://api.tokscript.com/api/connector/oauth/authorize"
$tokenUrl     = "https://api.tokscript.com/api/connector/oauth/token"

function New-PKCE {
    $rng      = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    $bytes    = [byte[]]::new(32)
    $rng.GetBytes($bytes)
    $verifier = [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
    $sha256   = [System.Security.Cryptography.SHA256]::Create()
    $hash     = $sha256.ComputeHash([Text.Encoding]::ASCII.GetBytes($verifier))
    $challenge = [Convert]::ToBase64String($hash).TrimEnd('=').Replace('+', '-').Replace('/', '_')
    return @{ Verifier = $verifier; Challenge = $challenge }
}

function New-State {
    $rng   = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    $bytes = [byte[]]::new(16)
    $rng.GetBytes($bytes)
    return [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
}

Write-Host ""
Write-Host "Registering OAuth client with TokScript..." -ForegroundColor Cyan

$regBody = @{
    client_name                = "Open Brain Social Media Ingestion"
    redirect_uris              = @($redirectUri)
    grant_types                = @("authorization_code", "refresh_token")
    token_endpoint_auth_method = "none"
} | ConvertTo-Json -Compress

$regResponse = Invoke-RestMethod -Uri $registerUrl -Method POST `
    -ContentType "application/json" -Body $regBody

$clientId = $regResponse.client_id
Write-Host "Client registered: $clientId" -ForegroundColor Green

$pkce  = New-PKCE
$state = New-State

$authQuery = "response_type=code" +
    "&client_id=$([Uri]::EscapeDataString($clientId))" +
    "&redirect_uri=$([Uri]::EscapeDataString($redirectUri))" +
    "&scope=mcp:access" +
    "&state=$([Uri]::EscapeDataString($state))" +
    "&code_challenge=$([Uri]::EscapeDataString($pkce.Challenge))" +
    "&code_challenge_method=S256"

$fullAuthUrl = "${authorizeUrl}?${authQuery}"

$listener = [System.Net.HttpListener]::new()
$listener.Prefixes.Add("http://localhost:${Port}/")
$listener.Start()

Write-Host ""
Write-Host "Opening browser for TokScript authentication..." -ForegroundColor Cyan
Write-Host "If the browser does not open, navigate to:" -ForegroundColor Yellow
Write-Host $fullAuthUrl -ForegroundColor Yellow
Write-Host ""
Write-Host "Waiting for callback on http://localhost:${Port}/callback ..." -ForegroundColor Cyan

Start-Process $fullAuthUrl

$context     = $listener.GetContext()
$callbackUrl = $context.Request.Url

$html = "<html><body style='font-family:sans-serif;padding:2rem'><h2>Authentication complete!</h2><p>You can close this tab.</p></body></html>"
$responseBytes = [Text.Encoding]::UTF8.GetBytes($html)
$context.Response.ContentType = "text/html"
$context.Response.OutputStream.Write($responseBytes, 0, $responseBytes.Length)
$context.Response.Close()
$listener.Stop()

$callbackParams = [System.Web.HttpUtility]::ParseQueryString($callbackUrl.Query)
$code           = $callbackParams["code"]
$returnedState  = $callbackParams["state"]

if ($returnedState -ne $state) {
    Write-Error "State mismatch. Aborting."
    exit 1
}

if (-not $code) {
    Write-Error "No authorization code in callback. Aborting."
    exit 1
}

Write-Host ""
Write-Host "Authorization code received." -ForegroundColor Green
Write-Host "Exchanging code for tokens..." -ForegroundColor Cyan

$tokenParams = "grant_type=authorization_code" +
    "&code=$([Uri]::EscapeDataString($code))" +
    "&redirect_uri=$([Uri]::EscapeDataString($redirectUri))" +
    "&client_id=$([Uri]::EscapeDataString($clientId))" +
    "&code_verifier=$([Uri]::EscapeDataString($pkce.Verifier))"

$tokenResponse = Invoke-RestMethod -Uri $tokenUrl -Method POST `
    -ContentType "application/x-www-form-urlencoded" -Body $tokenParams

Write-Host "Tokens received!" -ForegroundColor Green
Write-Host "Storing TokScript tokens in your Supabase function..." -ForegroundColor Cyan

$expiresIn = if ($tokenResponse.expires_in) { [int]$tokenResponse.expires_in } else { 3600 }

$initBody = @{
    provider_id   = "tokscript"
    access_token  = $tokenResponse.access_token
    refresh_token = $tokenResponse.refresh_token
    client_id     = $clientId
    expires_in    = $expiresIn
} | ConvertTo-Json -Compress

$initUrl = "${FunctionUrl}?action=init_tokens&key=$([Uri]::EscapeDataString($MCP_ACCESS_KEY))"

Invoke-RestMethod -Uri $initUrl -Method POST `
    -ContentType "application/json" -Body $initBody | Out-Null

Write-Host ""
Write-Host "Done! TokScript is now connected to Social Media Ingestion." -ForegroundColor Green
Write-Host "You can now use the save_social_media_transcript tool." -ForegroundColor Green
Write-Host ""
Write-Host "Client ID (save this in case you need to re-run setup):" -ForegroundColor Yellow
Write-Host $clientId -ForegroundColor Yellow
Write-Host ""
Write-Host "Recommended: set TOKSCRIPT_CLIENT_ID as a Supabase secret for hosted OAuth flows:" -ForegroundColor Yellow
Write-Host "supabase secrets set TOKSCRIPT_CLIENT_ID=$clientId" -ForegroundColor Yellow