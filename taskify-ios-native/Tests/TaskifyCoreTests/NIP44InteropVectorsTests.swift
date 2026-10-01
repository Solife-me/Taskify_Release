import CryptoKit
import Foundation
import XCTest
@testable import TaskifyCore
import TaskifyWatchShared

/// NIP-44 v2 interoperability (audit F2-8). Payloads were produced by `nostr-tools` 2.25, which is
/// tested against the published NIP-44 vectors, with fixed keys and nonces. Both Swift
/// implementations must reproduce them byte for byte and decrypt them. Plaintexts span the
/// padding boundaries and the 6-byte length form used above 65,535 bytes.
final class NIP44InteropVectorsTests: XCTestCase {
    private struct Vector {
        let length: Int
        let nonce: String
        /// Full payload for small cases; larger ones are checked by the payload's SHA-256.
        let payload: String?
        let payloadSHA256: String
    }

    private let sec1 = "08a5c0ae8050d4a8743ef2d28168bcbbad5e5e670e5968ac4e5bc88b025a5b32"
    private let sec2 = "2d78f6f29d25a1048bb20ebcb1283719cb712b5d306f7de5473d650a06449b30"
    private let pub2 = "6f7472bf5cf4b13db27ce329e910fdc949a86e3ac4d4ba73852e2eb6a4d5e4c4"
    private let conversationKey = "ca2c9c0bc24cb26cdc6fb5f0c2391ae3ef16d123063d2ef6e128c157e468aea5"

    private let vectors: [Vector] = [
        Vector(length: 1, nonce: "9e3f156324d42f0ea4b6f4fce81d56fbd64a2143a3fdd60a130d9c90e5b4d688", payload: "Ap4/FWMk1C8OpLb0/OgdVvvWSiFDo/3WChMNnJDltNaI2899krB+T1hJL8ix4QhmF2tZxMMKLPhUqvxv8SxA5ERyPp9DJ1YD31mxytBftWVAy8p7bXTJD2ofo1w3e5ilD6kL", payloadSHA256: "d1046e65dfd387a60c50ae8e816e5d13606a99b6e8709c8f59e2c335635c76b3"),
        Vector(length: 2, nonce: "7474c1e7ed929af580fe66e460b0603960defee0c8399f3c40a2a1660b7d6f09", payload: "AnR0weftkpr1gP5m5GCwYDlg3v7gyDmfPECioWYLfW8JghcVMOODnBTfBJw9wW/WWaQrx5r5is9OYLRqjq+G9g6XypLfDlwq/X0yCMYkTcjpZndLpZoHmHuCPCvF/darcrf5", payloadSHA256: "b3e5a32eac730d30550773ad8b2bbd8a0dae5b8093f8c0eac0ec19b69fc69d02"),
        Vector(length: 31, nonce: "933fcdad63106f07651b8b993277c37a0b64341e2f4d9ef369f724364ca02ddf", payload: "ApM/za1jEG8HZRuLmTJ3w3oLZDQeL02e82n3JDZMoC3fsRLxYN+h9GSYOjcfcy9YAUog6CBWkp8pPA5UZ/EbiU1b7amG0tvfIcPHs/mmVG9WlknfrAIYNSO+mqCSgc+Stb94", payloadSHA256: "228eac900dd2f8aa821d50e7512e7975ad7fe58e07bcfa0c56881aac1c614de9"),
        Vector(length: 32, nonce: "fd52fb6a3542c2ea258dbeeb03618b8db4772341580b08d7a284c7aa66264b71", payload: "Av1S+2o1QsLqJY2+6wNhi420dyNBWAsI16KEx6pmJktxFC9TxV7EHs7n+c5zgltdbK6dO+3rVt4s+CBR8TwC7zjZ4SkcnYzbHqjR2QE8UV2tEtrN3F2JfHys7i+ADl5Zq3Mb", payloadSHA256: "c337f4d62fc9b008e5dff90813b2410da0fc1108c74cb7a9457e7c143cd8cd13"),
        Vector(length: 33, nonce: "2d80ec2082296662c317c0605cf7ac1b9b0107698ccf4e9db40795d201571d59", payload: "Ai2A7CCCKWZiwxfAYFz3rBubAQdpjM9OnbQHldIBVx1ZOtubdONZaVWjsVZRdvwf4Gn7jv/tnc0qoeV/DN4Wf8bQyZtSFuEWQ33QrWUKtT2iEaWfKXm2wut+oeIDbQwkEpQb2064SIEmLWpNo6LiLYvwCiO/SUPGTqg0GtBHE1/TyZA=", payloadSHA256: "331b1344c812fc2763e9b559aae8f004e3fee210bc232500bd8d5e0846963f06"),
        Vector(length: 37, nonce: "274d66637934fe30c6877c285ccf7b4245c171043ea3a8388ccefacb046c252a", payload: "AidNZmN5NP4wxod8KFzPe0JFwXEEPqOoOIzO+ssEbCUqy25GVJeGW1Q+YbE8Iswjr6I2kevGdsC2o6Eqm9UViGTghDzy4z24XNGgU2VOFznb5BM61TpZtwG6IfNG24LS4upjtwDQatpdIeiwF4Mnu25yZ07H1EwboVynLgIFBKx6ke8=", payloadSHA256: "92f319ffd53fa9746c6c6eec8c9662a2e26ff7c8f503c6ea46f5541202835864"),
        Vector(length: 64, nonce: "290fd52150cf8c2b5762700d677c8cae3a1c3e287824b921825afe7fd4892681", payload: "AikP1SFQz4wrV2JwDWd8jK46HD4oeCS5IYJa/n/UiSaBWiu2KjC65bYI8XNMJ6rMJdTD5JhzSlmTjrMdhqvr5AVX/sZIhv8xMWaRNlF4th88Of9yqR5L4D86ODXiB0LMjTw8yb6XqfN5u4Ecq0hNNli5rgskdFagmk1iCV1OJVQB+gk=", payloadSHA256: "405d8a0de4c10a3e210e02911641466a03a8987b8601cdef35b74e115b466b97"),
        Vector(length: 65, nonce: "1603307aa0c676d5d3f502a0099f52365aded9cc16e37700ca01ad5b9e079fd6", payload: "AhYDMHqgxnbV0/UCoAmfUjZa3tnMFuN3AMoBrVueB5/WiUKsmqtyoHAwTnZmkMGII0YGbIbnJf2bOBqcaWTSs5MwDq5i+NeVp5/g0+KZJVA94nRamMexA6OgnTV/fl1RF1kAJi2LrA0zI3FxtcX6MUcO1y/ve3uGegapepfXoCPmy4xj8uu4l2m8RfK3PoJxx6Khuj9ZZ3258Kfqx0BaXlwjYQ==", payloadSHA256: "eef45baf20cbd55c7166e3ba6dabc5a47ffcf920476a06922f5ec564ad7e1da8"),
        Vector(length: 100, nonce: "751814fb27433a19bb6206e54b431689ff0774f4f16d995d80b9df00579ba631", payload: "AnUYFPsnQzoZu2IG5UtDFon/B3T08W2ZXYC53wBXm6YxSCC0KEA6jTSsFlLac/Ka3gJumY9wh3e+eBEHp2qv1HgpCz1aBimlEew/Jm6LFh24S4dbRPe5e/9iO/FwxXrd03sKB9/AfOYcXDyS8HOn5tzbPc4GiZz1NsW18YpzDX9V2HGjLXGI5+/ycsvvHP9S5+Qs8jIqdtXeuEmUNtk6BnI0EdmjL6xY11pk95V3NGR/AwwVp+ARiBzCkZXM2T312Y6R", payloadSHA256: "bdbb464dbfcf2d7063108520ed36b84dc8bd8e007daf4d0f4f45983ff0b490f0"),
        Vector(length: 255, nonce: "a840a41f5bba824f8dbbda41c79bce4c8665ce96362410ec0cfa9efcfae6667f", payload: "AqhApB9buoJPjbvaQcebzkyGZc6WNiQQ7Az6nvz65mZ/5uPD+BPlNWK+S1IFbHe6f7+SDrg5Q4GruvmQWq7MHr0H8gjBq8ZE2bf2JcrdckCxv4WoJrhl7pw5occ+6xlUBIkdGOm3LTWvVetZIDnsk2yi3YVXaWNaUSwMvNdp3ra6UOfIGGuC/DZ4eONtLgBcb3n6doccQ6LTIbfiLTOvrWfC7OSLuKsTROq61ZrkZqEjEj7lMhOX4O3ivk++V0X2ZgPS6mQiaMHK1owd6Uf3brs+g/Fvzq6J/NM7nJCUeaSd2lmOanFHuq8ZIPZkcv5IGYOn0THaabhdOpV62cAz/+f015LC4Q0TJ2DIzG9HSLX9x0ddhPQyX3zMZWSV0Popbxr7BR3PY9ihAEMBOrVhp2iNLHMFy3DFki9qH6je6b3YjKg=", payloadSHA256: "dd12a11e3d58f5e55a4dd5e536f7d49830c87dda96acf77801af172d62dcad6a"),
        Vector(length: 256, nonce: "7567c4e176bf43b695074f29008b4851d48566dfb5a2bb9b79bbb1651088e882", payload: "AnVnxOF2v0O2lQdPKQCLSFHUhWbftaK7m3m7sWUQiOiC0ghgKFay6ObLYtP8Kqj3c3TsIc4DearPuAMlZfCp3D646XJTwiapKhWouzewCCC+M10RTzIOK30T2o0GqWeP7wtRypDAS2CeKFvw5v/zuj1rN9PKLGJ+JVb7soY82N+8x7pl5SUeEAkhqhL+FjJzXS501zCn6b6fFpHoKE0XbyLl3ljeL2XgowZg06sgzDODcXXsH/x2H3zUQbShYaWg431Sc9PYIC2pVisEa4jKYp8Oug51o8K+sDpbsdvJLmQRgXsmr9PmFj+xZkT39W3VbYRrJz9K96Inko9LCrmZ6+xqtEWXqQ09Q49zZaWWdbmStUwPRl8AQP6nSf2of1uVrYEql/AVNu3wu7n0UiBMUd7lJajEJ+EH0otMEtlOMyeQgxA=", payloadSHA256: "d776d1d6a073b6937c492c5f60b26fad81f4171b1ca81c08afa249d613071b80"),
        Vector(length: 257, nonce: "e6f964abd81779d9d294808d9d20a892863a0cb771d4395629393e5b23b96dc2", payload: "Aub5ZKvYF3nZ0pSAjZ0gqJKGOgy3cdQ5Vik5PlsjuW3CV7e9G0zfX+z1FJOPX1amhvD+Vkz9d9GJp99w7fU3Y30801X076+YWOnQ+O52bdyEuVTmWIqS5iVCT3+INVqJCnNvmeYCRcIXaR1TLfT+5CLhzpyJOtLKz4jzJjzAzYXda7s4HGNQFX5wX/dbiPG+2hrKVAxkRStKbAizvYAJrIJGdAubWIT+ujfnRnZAyZqlGPEXmE20+jR+0tuDbIEz/AXbIQojE8r1Lnw29rCXXHhXHadVmFNy6rYsosFzR8M9dGZLLNC2ms/tiiGwK5197F3/s7rbVCX2CdDMRb/dNctqKAbAu+ILnZfgSHi+CcJRM1uTaHxVsJ/oZd7uvnOHvwATahcwB3/wHu1EhJcAv2EmKr8hMwy0IHn8AY1p3W0OCuNHc3V66LSRrOOLHd9BGVRFy/CgydELMsLUgwmbLl2IKQLwuILXeDX3Eo7+6gZmbrpKM0UiPtmX75guzOG9iUdN", payloadSHA256: "85e8aca938e05814c3a6065bf5bd9035ba465043ad1198b25f658d70226449f3"),
        Vector(length: 383, nonce: "0053535335841033892e5ee4cc02a945c387d24f3405636a2d440f72cdb6446f", payload: "AgBTU1M1hBAziS5e5MwCqUXDh9JPNAVjai1ED3LNtkRvMlf5K7pEoAu6+aO/t6d7zgAafBdFXyJj9b4xcUhFCC8yvxvUhmvNRCTRFJRFAVRVKz5WGGhvnauUu7Jyr+5fPIuwvqIrrEGOlAvmXwyew1qeYtrLPo4L1uggvR603+0r1cIGdvZNCRoxGLMW1juG8fnSflYDYu+x8q22Rk+iGIGXXeB7MSDNGY8cIbxNXxHc5eWmRSPO2Cx5/JqjsRRkw2nAmcXcIEDDOBRg8o9EWyG6DgYFLkDKpYYk0MRs6UDpdB+uL4T5hLk3PIr8hIlH2NFB/WNvvos8UZgySrcM2oTDxy/gWk/Lbfe56XvLcXPNZvpjYPOb9DH9YZF1umf93jywK+mBu43DVYinldJAedhwj9qZVjHYou0A1sdmcak+JNOCXVgIWJGXYfwGwkY4BSRGyHp+AKyvlBHRF/CX0HAQauwMVvck4DFe+dK9mcgK/zLcYVxTAuwVIH7jouEoacXHYuT+0iWyRPPBSV8UwNykjYsZF5JwYjNtm+J8+/zjDz/ellulVD/eNlIN1bEYBIscqDupVaTjaNCLAr1SLuqJyA==", payloadSHA256: "0c8c24eefe7b70cc67b81a1a109120b0191219b6232a9bab782c647940db7de6"),
        Vector(length: 1000, nonce: "e89df52ee8200b6fca7ac24834cce13cd20089b38100bfcd9f8ad920435981f8", payload: "Auid9S7oIAtvynrCSDTM4TzSAImzgQC/zZ+K2SBDWYH4dB5Gw4Mk6IyImzUkWcKbNmN0Al5WKJYzSG3XatwmVXd6nVYJ1clJrkP7SjgVeuQftxGCclXKuz5Z90r3NEEaHZOza6ah/9nJDb5QwI5/meqW//keniXBaWmbLv0bitB3nzG2+ztom5W9GP5rHPTCJBvWWlEsqidCGbaayzuLaYlqnhwaKmuBOvx4yXGk4GNg1xiqkvPjBsVOrwIQiV4E9zDNaYGsVX2rUxKnj4I77n+MzmQwHoYlcEEpT88P5BCobv4Qp5BEa0USmpw1Alfudl4GDQPYvf7Ocky9S+/IVTWav2cqnsh+pxtL8It/h23FpT75NKAMuHNUKZto7Z6hHDvUdtWJqOe2eFI5ctqkBj/HwPNycdyuDGYb9/Iovs5QZUhzd+PjvoppAQt6aqYqjyDCPE7vvqaVrJ1vNw58v/j8RVxRFYVGApFx2Rey1/KQa6oySjeydlZUZLVNfabil578w4oXy8jT3SZVgFhY3YpdPJ2H+VoQSZqYU3kVW5VUYg5TOQ+UGrXwsYB8paggxRUM+bHqlOWF2OqMza3oktin/DAYKn4vufN/vtaxDar4mndRgdlH3NSqGZBS0amtS6USLJHUFSLSh2f3/WT9L2mZwgq0kBpIiV7+84vTGYn6vwW2aOOtn15VMGCb0SUjGwU9JgmZC346BFNrZRc6naXVrtFjxyy584Doi7z9oVHpk5DCXAgYywy6OMLPc1JWhZOgGrybAiUrkvjnVo1re1p8J/bEY4d/VTyHU8Su2IZLTEDFJ54lpLumMpeVPlZgQcbsLJPqG+CW3wIfcsKmytPbst2EuoWtCtubmmQWWnKTcrw0Pvml6E15jM+DYfkc2SbQpbJTRNxE26u8tUH3e+xs0uC63JNxWeyH2HjT1j//kRaVLEtQGI2HYXjH5zBPvupZQHxiod+eIhJHx0elvFYOYzSeQ1q5rm5i9AjoC8uxIpHcOJAfo/BHjajfUVpikqriFi+d8fhF17gbOY5HC80IaIWlfKh1Cen9z3WE8Pbckw0W+8Bs0h9PG/IeLeI21qNRtXXvplAJOauzKIjVTpzlRcsH2GnOP6ILxitK5RhjpqUOPR9OblD/LchKoSPmLw2qyR+rsYWo7pDlC4Os4dm7CLXq+eX8pd2gLg+Y1hhDayWxihmVaXcjDD4bQ5cDdO0ZJ++EG3+/DucYAOudAyOsKK83+tCUyMwKD1YY0P8pzP++knXRy4Aq0eWXLM5x2Q/+ttxFn7utfQYan+cZPhPtFhGTdf4lnW3VNMGWgDlMGWEAfKYCLb0DHwwKeJrtPG1cugjFdDX+Q03x95nz38RMJVR8FA+8223WBfYnQOKYmOGJ41bQMgfHjqDCGz8eIICdJF7HzGveIfesnV5J3YS9SCA4GHEDrZCJ7m2iJc49bI8=", payloadSHA256: "fced66eb83a138af8b701582e0ad34116544d04377d5c40b13c0742ad5d3f479"),
        Vector(length: 1025, nonce: "0829ecc71377eb39cdaa416674ccf440862f9c3d9be28f827b061326846fe7a8", payload: "Aggp7McTd+s5zapBZnTM9ECGL5w9m+KPgnsGEyaEb+eocGDaK3fV8Ypokx5kOXPSg3GEKuoBjRJoEFrTXaZ4rFbbUi+WZ6TOOo9PHBCCHOFvl5VthZh4cHgJ+UR4nRH4+CXxTSMFwA1FlWafeuk2K4yw/BUJTLQQoz/e2+B35NG3qySjK9Wh9ixpvJFuMLq4kGcgCP8PxFCfGick/hZj9F/LZ2qceNC6ZBuPhr7J8Sl7MJMg5drBQM3cjl4WV3JfyvyFi+aet4659WUrK9yRHd5uJBAX+nS6WMdwQBl4iejUdPr0lY0DSG+tmQ58nak6Cm9v6enppix9Z5Wn/jJ1zTkJ7IW9aYBaziAjxXQpbdyZiU4BESHbQEFq6vKSwI/dDrWfXKS4b43DEJrB7ew0AsixrvFwdCvD8DAa8id9Y70pbcXKJAU1WYm8f8ncQ6MaLF28MG0hUEwxeZOYc6E9kinA+nHBoWN2uZVwBfRtXRIC5le1Ld2VVcaJfeHDZ99bbTo1dgTpn+jF06HdrviWUB8EBsuA2ADFU3j3wnMIGDUaM9DupFy8BNoqtoU72x2m17hqBQ3iBA0Zi8aVxby7J6rgrDyzn0JJ1OZlEDHq7/lqw40VsPpNL8EQjSrOz1bWKTFlUkC+ZHUexI9P6Fspm7CsjKJR3wbtgRXV+0BcxPtL62rz5yfGfRpI+CH/0D6mnZ02VZsjJ/sbI9XzVQMewNoftQJjV5POiAIBAJwpatYRPTtJ9gStCU5U3+S0sGtcDWzMtQEVh1DzEvRK+J39HwWKPVxvQ2sGqN07lPLt3EHs3hsUudzFGgxNlOf7kjtcbnMwIvfTmWxg2hRZ9qrzgQxkXhvJVvmTzdiLu5B/MyUbU8iCsuEVsqruCvt79zPUsm1TdQ3O89s06Ky0/s8fou+kyEJD3WCm0Ffbkdc4Nbq2KQtC9cKdficJoqEs3fjp51bptHWCyQm6cUIA5mpP87LzpUwKxvhkASwA0cYk22wqRW4I8Wi03ADbkWsDTNO7+CdeCsGvirQeGdzs5DxnN0Du2riWP5M6L0OPlfI3S3bWWIMp43TdNK+zCamagtBdKCGnCOUOSW0jkFJ+oLsyOsQ5sXbM9do57l8p5VenPmhNgv/OnFXtp3nf7ts2wVe4eP14Essg4Ksi81Co2E5MqNxTadN0rMF6e0JUqNBQcZ+r2j4bN4ZqpwqQwYbfkvTh/q2rXctesYUOqCHa1KlpzmVR/qFYLIjgaHMrB6Pjl6T9fztGwoedIXi53DaXe/r/VNro52seLj+29y/ByRxQ6Q8mGBBifZkIzASVFSzHS8pDshpiiU28pp/01uBt7ZfAdU5c0JqNojVFlIr1VVVyCp4j0SD14q30vGfEv7qpqp4xABl+7gAIh4otCpO1Q+dj+oYw/OeX/sIkN6ozrORgZ4ssnIE9h8iu31pPsaCMF7AYw4TIwbC/OO6OmiolcRiEeNws9LGdeoBB3uHZMpAH+73LLatSDM8GTv7kvmZ14hcbxuiE25JsP2VxV2sF8fZxI+8p4rhVz8/wzK7An0bPs3URkDR2X3axsVB61/RRgolGUCfZdYYP8qrlyPM+HfPXcI2tl7Jyke8CTUzQ0T39UgP2G6wASiFVn/tIx1Jb2NWJDlsvQgXAJedC3HygQFNCuxZrdZCHjGwR8ttW9npO7Yndmzm5FPLQeBG3hzG95iVGXQfDh40LZ+8NCWFrI5Y9mkbkvvn3UawSC76PKjpuEfW1oHR9tX2Mi/iU82TYC3HhjhWoiA40Dzb5YNhJ3w2ais+T", payloadSHA256: "9ff1f123e088f5cc6189028bef4c5f46c5d935cf65a57b0ff8dd28cc197dd894"),
        Vector(length: 4096, nonce: "1e76ac056339d5517d2b4a932ec91695bcc16448f603b99b38baafeb55b747ec", payload: nil, payloadSHA256: "044185890bf332e12c3025f169df884b049e0934a58e7653bf8feff6615db8f5"),
        Vector(length: 65535, nonce: "06e4ba420c9eedf68c5dbb93ea718edec72c16ae1869c74e179a50205b84735d", payload: nil, payloadSHA256: "8205d7444f4909d15cb2414ca70e3d4ee0f8fdcae0b7db9a15cbfcc6b389876d"),
        // Over 65,535 bytes: the 6-byte length form, which nostr-tools 2.25 writes the same way.
        Vector(length: 65536, nonce: "34db25fcd900219062bbaa56a20a164150b7915820b7087d6158c6eedb6def02", payload: nil, payloadSHA256: "bb4b1546a665b2747b50274bccc9e11bee34648c26d75c1a8655d1b34afd5e3e"),
        Vector(length: 100000, nonce: "b4ff085bb3c5a69dd1ff14a099197a2192ecdd1f66fe7b796f14d3ac1733b245", payload: nil, payloadSHA256: "a7ffae07f33987a876d2ce3c0926d6d1b9daa6a8938d35eee9f05dbc5e9c09da"),
        Vector(length: 300000, nonce: "97f891602778d045b13e13a18a7e5aa22302c8f7bafcee06cb53fb59c2a2a8e6", payload: nil, payloadSHA256: "0c7c4175520300cd0ed86e72d814eb3c9877a326869f84b7df65530331f587e8"),
    ]

    private func hex(_ value: String) -> Data {
        var data = Data()
        var index = value.startIndex
        while index < value.endIndex {
            let next = value.index(index, offsetBy: 2)
            data.append(UInt8(value[index..<next], radix: 16)!)
            index = next
        }
        return data
    }

    private func plaintext(length: Int) -> Data {
        Data((String(repeating: "a", count: length - 1) + (length % 2 == 1 ? "z" : "y")).utf8)
    }

    private func sha256Hex(_ text: String) -> String {
        Data(SHA256.hash(data: Data(text.utf8))).map { String(format: "%02x", $0) }.joined()
    }

    func testSpecConversationKey() throws {
        // First vector of the NIP-44 spec: secret keys 1 and 2.
        let one = hex(String(repeating: "0", count: 63) + "1")
        let two = try NostrIdentity(privateKey: hex(String(repeating: "0", count: 63) + "2"))
        let expected = "c41c775356fd92eadc63ff5a0dc1da211b268cbea22316767095b2871ea1412d"
        XCTAssertEqual(try NIP44V2.conversationKey(privateKey: one, publicKey: two.publicKey), hex(expected))
        XCTAssertEqual(try TaskifyWatchNIP44V2.conversationKey(privateKey: one, publicKey: two.publicKey), hex(expected))
    }

    func testConversationKeyMatchesReference() throws {
        XCTAssertEqual(try NIP44V2.conversationKey(privateKey: hex(sec1), publicKey: hex(pub2)), hex(conversationKey))
        XCTAssertEqual(try TaskifyWatchNIP44V2.conversationKey(privateKey: hex(sec1), publicKey: hex(pub2)), hex(conversationKey))
    }

    func testBothImplementationsReproduceAndDecryptReferencePayloads() throws {
        let key = hex(conversationKey)
        for vector in vectors {
            let input = plaintext(length: vector.length)
            let core = try NIP44V2.encrypt(input, conversationKey: key, nonce: hex(vector.nonce))
            let watch = try TaskifyWatchNIP44V2.encrypt(input, conversationKey: key, nonce: hex(vector.nonce))
            XCTAssertEqual(sha256Hex(core), vector.payloadSHA256, "core, length \(vector.length)")
            XCTAssertEqual(watch, core, "watch, length \(vector.length)")
            if let payload = vector.payload {
                XCTAssertEqual(core, payload, "length \(vector.length)")
            }
            XCTAssertEqual(try NIP44V2.decrypt(core, conversationKey: key), input)
            XCTAssertEqual(try TaskifyWatchNIP44V2.decrypt(core, conversationKey: key), input)
        }
    }

    func testMultibyteText() throws {
        let key = hex(conversationKey)
        let payload = "ApkiR+xgICO0mOeRN1aFKQP6k6x+5mbBTNEYD0blwZ8gu3vvDjmph9TB0cfCBePuS1tL3B35yyQQqSCNtbTzBSFFcquZnh3yJdPS5a9AQFxFq3TGxdrwAnuk1jznvHKInhNM"
        let text = Data("Täsk 🧭 — 日本語".utf8)
        XCTAssertEqual(try NIP44V2.encrypt(text, conversationKey: key, nonce: hex("992247ec602023b498e7913756852903fa93ac7ee666c14cd1180f46e5c19f20")), payload)
        XCTAssertEqual(try NIP44V2.decrypt(payload, conversationKey: key), text)
        XCTAssertEqual(try TaskifyWatchNIP44V2.decrypt(payload, conversationKey: key), text)
    }

    func testTamperedPayloadsAreRejected() throws {
        let key = hex(conversationKey)
        let payload = vectors[0].payload!
        var raw = Data(base64Encoded: payload)!
        raw[raw.count - 1] ^= 0x01
        XCTAssertThrowsError(try NIP44V2.decrypt(raw.base64EncodedString(), conversationKey: key))
        XCTAssertThrowsError(try TaskifyWatchNIP44V2.decrypt(raw.base64EncodedString(), conversationKey: key))
        var version = Data(base64Encoded: payload)!
        version[0] = 1
        XCTAssertThrowsError(try NIP44V2.decrypt(version.base64EncodedString(), conversationKey: key))
        XCTAssertThrowsError(try TaskifyWatchNIP44V2.decrypt(version.base64EncodedString(), conversationKey: key))
    }
}
