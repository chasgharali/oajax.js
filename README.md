
# oajax.js

oajax.js is offline based http/https request handler which can handle the http request whether server is offline or online .when server is not available or offline its maintain state of request using local data storage of browser and when server is online its automatically sync the locally maintained request states with server . oajax also give support of get or post data when server is not available so that's why it is very useful tool for js based mobile application development platform like Phonegap (cordova) where local data handling is big challenge 

Download [oajax.min.js](https://raw.githubusercontent.com/chasgharali/oajax.js/master/dist/oajax.min.js) 

or use [Bower](http://bower.io/) to install:

```bash
$ bower install oajax.js --save
```



## Usage
**This library use instead of ajax request in otherword its offline ajax request handler so you can easily replace your ajax request with oajax to make your app works offline perfectly.**

### basic http request method is same as for ajax in jquery

```javascript
	
    $oajax({url: "http://localhost/phonegap/getData.php" ,  success: function(result){
                      console.log(result);
	         },
		 error : function(err){
			console.log(err);
		 }
	});
```


**Keywords**

javascript, js, jquery, node.js, oajax, offline http request, offline database, realm, local webstorage, sqllite, phonegap, cordova,local database , oajax.js , ojax, ojax.js


