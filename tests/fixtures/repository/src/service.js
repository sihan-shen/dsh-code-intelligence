export function serve(request) {
  return authenticate(request.token)
}
