import { createHash } from 'node:crypto'
import {
  ProductAssetAnimatedContentError,
  ProductAssetChecksumMismatchError,
  ProductAssetInvalidContentError,
  ProductAssetLengthMismatchError,
} from '../../application/errors/ApplicationError'

export interface ValidatedImageDetails {
  readonly width: number
  readonly height: number
  readonly format: 'jpeg' | 'png' | 'webp'
  readonly sha256Hex: string
}

const MIN_DIMENSION = 256
const MAX_DIMENSION = 4096
const MAX_PIXELS = 20_000_000
const MAX_FILE_SIZE = 5 * 1024 * 1024 // 5 MiB

const verifyChecksum = (declared: string, calcHex: string, calcBase64: string): void => {
  const cleanDeclared = declared.trim()

  if (cleanDeclared.startsWith('b64:')) {
    const expectedB64 = cleanDeclared.slice(4)
    if (expectedB64 !== calcBase64) {
      throw new ProductAssetChecksumMismatchError(
        `Checksum SHA-256 no coincide. Esperado base64 "${expectedB64}", calculado "${calcBase64}".`,
      )
    }
    return
  }

  if (cleanDeclared === calcHex || cleanDeclared.toLowerCase() === calcHex.toLowerCase()) {
    return
  }

  if (cleanDeclared === calcBase64) {
    return
  }

  throw new ProductAssetChecksumMismatchError(
    `Checksum SHA-256 no coincide con el archivo cargado.`,
  )
}

const assertNoApng = (buffer: Buffer): void => {
  let offset = 8 // Skip PNG signature
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset)
    const type = buffer.subarray(offset + 4, offset + 8).toString('ascii')

    if (type === 'acTL') {
      throw new ProductAssetAnimatedContentError(
        'No se admiten imagenes animadas: chunk acTL detectado (APNG).',
      )
    }

    if (type === 'IEND') {
      break
    }

    offset += 12 + length // 4 (len) + 4 (type) + length (data) + 4 (crc)
  }
}

const assertNoAnimatedWebp = (buffer: Buffer): void => {
  let offset = 12
  while (offset + 8 <= buffer.length) {
    const chunkType = buffer.subarray(offset, offset + 4).toString('ascii')
    const chunkSize = buffer.readUInt32LE(offset + 4)

    if (chunkType === 'VP8X') {
      if (offset + 8 < buffer.length) {
        const flags = buffer[offset + 8] ?? 0
        // Bit 1 is the ANIM flag
        if ((flags & 0x02) !== 0) {
          throw new ProductAssetAnimatedContentError(
            'No se admiten imagenes animadas: flag ANIM detectado en WebP VP8X.',
          )
        }
      }
    }

    if (chunkType === 'ANMF') {
      throw new ProductAssetAnimatedContentError(
        'No se admiten imagenes animadas: chunk ANMF detectado en WebP.',
      )
    }

    offset += 8 + chunkSize + (chunkSize % 2) // Chunks are 2-byte aligned
  }
}

const extractDimensions = (
  buffer: Buffer,
  format: 'jpeg' | 'png' | 'webp',
): { width: number; height: number } => {
  if (format === 'png') {
    // First chunk is always IHDR at offset 8
    if (buffer.length < 24) {
      throw new ProductAssetInvalidContentError('Cabecera PNG incompleta.')
    }
    const width = buffer.readUInt32BE(16)
    const height = buffer.readUInt32BE(20)
    return { width, height }
  }

  if (format === 'jpeg') {
    let offset = 2
    while (offset < buffer.length) {
      while (offset < buffer.length && buffer[offset] === 0xff) {
        offset++
      }
      if (offset >= buffer.length) break
      const marker = buffer[offset++]
      if (marker === undefined) break

      // SOF markers: 0xC0 to 0xC3, 0xC5 to 0xC7, 0xC9 to 0xCB, 0xCD to 0xCF
      const isSof =
        (marker >= 0xc0 && marker <= 0xc3) ||
        (marker >= 0xc5 && marker <= 0xc7) ||
        (marker >= 0xc9 && marker <= 0xcb) ||
        (marker >= 0xcd && marker <= 0xcf)

      if (isSof) {
        if (offset + 7 > buffer.length) {
          throw new ProductAssetInvalidContentError('Cabecera SOF JPEG truncada.')
        }
        const height = buffer.readUInt16BE(offset + 3)
        const width = buffer.readUInt16BE(offset + 5)
        return { width, height }
      }

      if (marker === 0xd9 || marker === 0xda) {
        // EOI or SOS
        break
      }

      if (offset + 2 > buffer.length) break
      const length = buffer.readUInt16BE(offset)
      offset += length
    }

    throw new ProductAssetInvalidContentError(
      'No se pudo determinar las dimensiones de la imagen JPEG.',
    )
  }

  // WebP
  const chunkType = buffer.subarray(12, 16).toString('ascii')

  if (chunkType === 'VP8 ') {
    if (buffer.length < 30) {
      throw new ProductAssetInvalidContentError('Cabecera WebP VP8 truncada.')
    }
    const width = buffer.readUInt16LE(26) & 0x3fff
    const height = buffer.readUInt16LE(28) & 0x3fff
    return { width, height }
  }

  if (chunkType === 'VP8L') {
    if (buffer.length < 25) {
      throw new ProductAssetInvalidContentError('Cabecera WebP VP8L truncada.')
    }
    const b1 = buffer[21] ?? 0
    const b2 = buffer[22] ?? 0
    const b3 = buffer[23] ?? 0
    const b4 = buffer[24] ?? 0
    const width = 1 + (((b2 & 0x3f) << 8) | b1)
    const height = 1 + (((b4 & 0xf) << 10) | (b3 << 2) | ((b2 & 0xc0) >> 6))
    return { width, height }
  }

  if (chunkType === 'VP8X') {
    if (buffer.length < 30) {
      throw new ProductAssetInvalidContentError('Cabecera WebP VP8X truncada.')
    }
    const width = 1 + buffer.readUIntLE(24, 3)
    const height = 1 + buffer.readUIntLE(27, 3)
    return { width, height }
  }

  throw new ProductAssetInvalidContentError(`Chunk WebP no reconocido: "${chunkType}".`)
}

export const ImageContentValidator = {
  validate(params: {
    buffer: Buffer
    declaredContentType: string
    declaredContentLength: number
    declaredChecksumSha256: string
  }): ValidatedImageDetails {
    const { buffer, declaredContentType, declaredContentLength, declaredChecksumSha256 } = params

    // 1. Validar longitud
    if (buffer.length !== declaredContentLength) {
      throw new ProductAssetLengthMismatchError(
        `La longitud del archivo (${String(buffer.length)}) no coincide con la longitud declarada (${String(declaredContentLength)}).`,
      )
    }

    if (buffer.length > MAX_FILE_SIZE) {
      throw new ProductAssetInvalidContentError(
        `El tamano del archivo (${String(buffer.length)} bytes) supera el maximo permitido de 5 MiB.`,
      )
    }

    if (buffer.length < 16) {
      throw new ProductAssetInvalidContentError(
        'El archivo es demasiado pequeno para ser una imagen valida.',
      )
    }

    // 2. Validar Checksum SHA-256
    const calculatedHex = createHash('sha256').update(buffer).digest('hex')
    const calculatedBase64 = createHash('sha256').update(buffer).digest('base64')

    verifyChecksum(declaredChecksumSha256, calculatedHex, calculatedBase64)

    // 3. Rechazar formatos no admitidos explicitamente (SVG, BMP)
    const headerPrefix = buffer.subarray(0, 16).toString('utf-8')
    if (
      headerPrefix.includes('<svg') ||
      headerPrefix.includes('<?xml') ||
      buffer.subarray(0, 2).toString('ascii') === 'BM'
    ) {
      throw new ProductAssetInvalidContentError(
        'Formatos SVG y BMP no estan permitidos por motivos de seguridad.',
      )
    }

    // 4. Validar Magic Bytes y Tipo
    let format: 'jpeg' | 'png' | 'webp'
    if (declaredContentType === 'image/jpeg') {
      if (buffer[0] !== 0xff || buffer[1] !== 0xd8 || buffer[2] !== 0xff) {
        throw new ProductAssetInvalidContentError(
          'Magic bytes no corresponden a una imagen JPEG valida.',
        )
      }
      format = 'jpeg'
    } else if (declaredContentType === 'image/png') {
      const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
      if (!buffer.subarray(0, 8).equals(pngSignature)) {
        throw new ProductAssetInvalidContentError(
          'Magic bytes no corresponden a una imagen PNG valida.',
        )
      }
      format = 'png'
    } else if (declaredContentType === 'image/webp') {
      const isRiff = buffer.subarray(0, 4).toString('ascii') === 'RIFF'
      const isWebp = buffer.subarray(8, 12).toString('ascii') === 'WEBP'
      if (!isRiff || !isWebp) {
        throw new ProductAssetInvalidContentError(
          'Magic bytes no corresponden a una imagen WebP valida.',
        )
      }
      format = 'webp'
    } else {
      throw new ProductAssetInvalidContentError(
        `Tipo de contenido no admitido: "${declaredContentType}". Solo se admiten JPEG, PNG o WebP.`,
      )
    }

    // 5. Inspeccionar estructura para detectar y rechazar animación (ADR-016)
    if (format === 'png') {
      assertNoApng(buffer)
    } else if (format === 'webp') {
      assertNoAnimatedWebp(buffer)
    }

    // 6. Decodificar dimensiones y verificar límites
    const { width, height } = extractDimensions(buffer, format)

    if (
      width < MIN_DIMENSION ||
      width > MAX_DIMENSION ||
      height < MIN_DIMENSION ||
      height > MAX_DIMENSION
    ) {
      throw new ProductAssetInvalidContentError(
        `Las dimensiones (${String(width)}x${String(height)}) estan fuera de rango permitido [${String(MIN_DIMENSION)}-${String(MAX_DIMENSION)} px].`,
      )
    }

    const totalPixels = width * height
    if (totalPixels > MAX_PIXELS) {
      throw new ProductAssetInvalidContentError(
        `El area total (${String(totalPixels)} px) supera la defensa en profundidad de 20 megapixeles.`,
      )
    }

    return {
      width,
      height,
      format,
      sha256Hex: calculatedHex,
    }
  },
}
