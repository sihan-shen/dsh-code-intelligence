declare module 'picomatch' {
  type PicomatchOptions = {
    readonly dot?: boolean
  }
  type Matcher = (input: string) => boolean
  export default function picomatch(pattern: string, options?: PicomatchOptions): Matcher
}
